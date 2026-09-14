/** Private recipe browsing. Choices save locally; only Add changes the week. */
import { el, button, focusQuietly } from './dom.js';
import { api } from './api.js';
import { mealPhoto, mealPhotoFigure, mealPhotoCredit } from './meal-photos.js';

const slots = ['breakfast', 'lunch', 'dinner'];
const label = value => String(value || '').replace(/-/g, ' ').replace(/^./, letter => letter.toUpperCase());
const key = recipe => recipe.discoveryId;
const tags = recipe => (Array.isArray(recipe.tags) ? recipe.tags : []).map(value => String(value).toLowerCase());
const money = (value, currency = 'USD') => {
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(value / 100); }
  catch { return `${(value / 100).toFixed(2)} ${currency}`; }
};
const price = recipe => Number.isFinite(recipe.costHigh) ? recipe.costHigh : Infinity;
const estimate = recipe => Number.isFinite(recipe.costLow) && Number.isFinite(recipe.costHigh)
  ? `${money(recipe.costLow, recipe.priceCurrency)}–${money(recipe.costHigh, recipe.priceCurrency)} / serving` : 'Price estimate unavailable';
const days = weekStart => Array.from({ length: 7 }, (_, index) => {
  const date = new Date(`${weekStart}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + index);
  return { index, date: Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : '',
    label: Number.isFinite(date.getTime()) ? date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }) : `Day ${index + 1}` };
});
const defaults = () => ({ search: '', slot: '', minutes: '', price: '', diet: '', protein: '', cuisine: '', sort: 'recommended' });
function interleaveMeals(recipes) {
  const groups = slots.map(slot => recipes.filter(recipe => recipe.slot === slot));
  const mixed = [];
  for (let index = 0; index < Math.max(...groups.map(group => group.length)); index++) {
    for (const group of groups) if (group[index]) mixed.push(group[index]);
  }
  return [...mixed, ...recipes.filter(recipe => !slots.includes(recipe.slot))];
}

export function createMealDiscovery({ getWeek, onWeekUpdated = async () => {}, onViewWeek = () => {} } = {}) {
  const state = { data: null, loadedWeek: null, mode: 'browse', filters: defaults(), limit: 24, busy: false,
    loading: false, conflict: false, error: '', notice: '', undo: null, replay: false, seen: new Set(),
    expanded: new Set(), targets: new Map(), request: 0, disposed: false, reloadAfter: false, focusDeck: false };
  const root = el('section', { class: 'meal-discovery', 'aria-label': 'Discover meals' });
  const controls = {}, modeButtons = new Map();
  const week = () => getWeek?.() || {};
  const saved = () => new Set(state.data?.favorites || []);
  const skipped = () => new Set(state.data?.skipped || []);
  const unavailable = () => state.busy || state.loading || state.conflict || !state.data || state.data.blocked;
  function addIssue() {
    const current = week();
    if (current.locked) return 'Wait for your current week to finish saving or generating.';
    if (current.dirty || current.preferencesDirty) return 'Save your current week choices and preferences first.';
    if (current.stale || state.data?.stale || current.weekStart !== state.loadedWeek) return 'Refresh your week and preferences before adding a meal.';
    if (state.data?.blocked) return state.data.warnings?.[0] || 'Update your meal preferences to use these recipes.';
    return '';
  }
  const info = el('p', { class: 'md-info' });
  const aboutText = el('p', { class: 'md-info' });
  const about = el('details', { class: 'md-about' }, [el('summary', { text: 'About these ideas' }), aboutText]);
  const status = el('p', { class: 'md-status', role: 'status', 'aria-live': 'polite' });
  const results = el('p', { class: 'md-results', role: 'status' });
  const content = el('div', { class: 'md-content' });
  const chips = el('div', { class: 'md-chips', 'aria-label': 'Active meal filters' });
  const filterCount = el('span', { class: 'md-filter-count' });
  const undoButton = button('Undo last choice', { class: 'btn quiet', onClick: () => undo() });
  const replayButton = button('Replay skipped', { class: 'btn quiet', onClick: () => {
    state.mode = 'swipe'; state.replay = true; state.seen.clear(); state.notice = 'Revisit your skipped ideas. Your saved choices stay unchanged until you choose.'; paint();
  } });
  const refreshButton = button('Refresh ideas', { class: 'btn quiet', onClick: () => reload() });
  const weekButton = button('View your week', { class: 'btn quiet', onClick: () => onViewWeek() });
  const more = button('Show 24 more', { class: 'btn quiet md-more', onClick: () => { state.limit += 24; paint(); } });
  const resetButton = button('Reset filters', { class: 'btn quiet', onClick: () => reset() });

  function field(name, control) { return el('label', { class: 'md-field' }, [el('span', { text: name }), control]); }
  function select(name, values, property) {
    const node = el('select', { class: 'input', 'aria-label': name, onchange: event => filter(property, event.target.value) });
    controls[property] = node; options(node, values, state.filters[property]); return node;
  }
  function options(node, values, value) {
    node.replaceChildren(...values.map(([id, title]) => el('option', { value: id, text: title })));
    node.value = value;
  }
  function filter(property, value) { state.filters[property] = value; state.limit = 24; paint(); }
  function reset() {
    state.filters = defaults(); state.limit = 24;
    for (const [property, control] of Object.entries(controls)) control.value = state.filters[property];
    paint();
  }
  controls.search = el('input', { class: 'input md-search', type: 'search', 'aria-label': 'Search meal ideas',
    placeholder: 'Find a meal, ingredient, or cuisine', oninput: event => filter('search', event.target.value) });
  controls.price = el('input', { class: 'input', type: 'number', min: '0', step: '.50', 'aria-label': 'Maximum price per serving in USD',
    placeholder: 'Any price', oninput: event => filter('price', event.target.value) });
  const filterPanel = el('details', { class: 'md-filters' }, [
    el('summary', {}, [el('span', { text: 'Refine your ideas' }), filterCount]),
    el('div', { class: 'md-filter-grid' }, [
      field('Meal', select('Meal type', [['', 'All meals'], ...slots.map(value => [value, label(value)])], 'slot')),
      field('Cooking time', select('Maximum cooking minutes', [['', 'Any time'], ...[15, 30, 45, 60].map(value => [String(value), `${value} minutes or less`])], 'minutes')),
      field('Up to / serving · USD', controls.price),
      field('Diet', select('Diet filter', [['', 'All recipes'], ...['vegetarian', 'vegan', 'dairy-free', 'gluten-free'].map(value => [value, label(value)])], 'diet')),
      field('Protein', select('Protein filter', [['', 'Any protein']], 'protein')),
      field('Cuisine', select('Cuisine filter', [['', 'Any cuisine']], 'cuisine')),
    ]),
  ]);
  const modes = el('div', { class: 'md-modes', role: 'group', 'aria-label': 'Meal discovery mode' }, ['browse', 'swipe', 'saved'].map(mode => {
    const node = button(label(mode), { class: 'md-mode', 'aria-pressed': String(mode === state.mode), onClick: () => {
      state.mode = mode; state.replay = false; state.limit = 24; paint();
    } }); modeButtons.set(mode, node); return node;
  }));
  root.appendChild(el('div', { class: 'md-heading' }, [el('div', {}, [el('h2', { text: 'Find your next favorite' }),
    el('p', { text: 'Fresh ideas for everyday cooking. Save what you love, then make it part of your week.' })]), weekButton]));
  root.appendChild(el('div', { class: 'md-toolbar' }, [modes, controls.search]));
  root.appendChild(filterPanel); root.appendChild(chips);
  root.appendChild(el('div', { class: 'md-result-bar' }, [results,
    field('Sort', select('Sort meal ideas', [['recommended', 'Recommended'], ['quickest', 'Quickest'], ['price', 'Lowest estimated price']], 'sort'))]));
  root.appendChild(info); root.appendChild(status); root.appendChild(content); root.appendChild(more);
  root.appendChild(el('div', { class: 'md-utilities' }, [undoButton, replayButton, refreshButton, resetButton]));
  root.appendChild(about);

  function visible() {
    const f = state.filters, favorites = saved(), passed = skipped();
    // Mix the complete catalog before filtering so choosing a card advances
    // through a stable breakfast/lunch/dinner deck instead of restarting it.
    const source = state.data?.recipes || [];
    let recipes = (f.sort === 'recommended' ? interleaveMeals(source) : source).filter(recipe => {
      const recipeTags = tags(recipe);
      if (state.mode === 'saved' && !favorites.has(key(recipe))) return false;
      if (state.mode === 'swipe' && (state.seen.has(key(recipe)) || (state.replay ? !passed.has(key(recipe)) : favorites.has(key(recipe)) || passed.has(key(recipe))))) return false;
      if (f.slot && recipe.slot !== f.slot) return false;
      if (f.minutes && !(Number(recipe.minutes) <= Number(f.minutes))) return false;
      if (f.price && Number(f.price) >= 0 && ((recipe.priceCurrency || 'USD') !== 'USD' || price(recipe) > Number(f.price) * 100)) return false;
      if (f.diet && !recipeTags.includes(f.diet) && !(f.diet === 'vegetarian' && recipeTags.includes('vegan'))) return false;
      if (f.protein && recipe.protein !== f.protein) return false;
      if (f.cuisine && recipe.cuisine !== f.cuisine) return false;
      const haystack = [recipe.title, recipe.description, recipe.cuisine, recipe.protein, ...recipeTags,
        ...(recipe.ingredients || []).map(ingredient => ingredient.name)].join(' ').toLowerCase();
      return f.search.toLowerCase().trim().split(/\s+/).every(word => haystack.includes(word));
    });
    if (f.sort === 'quickest') recipes = recipes.slice().sort((a, b) => (a.minutes ?? Infinity) - (b.minutes ?? Infinity));
    if (f.sort === 'price') recipes = recipes.slice().sort((a, b) => String(a.priceCurrency || 'USD').localeCompare(String(b.priceCurrency || 'USD')) || price(a) - price(b));
    return recipes;
  }
  function refreshFacets() {
    for (const [property, any] of [['protein', 'Any protein'], ['cuisine', 'Any cuisine']]) {
      const values = [...new Set([...(state.data?.recipes || []).map(recipe => recipe[property]), state.filters[property]].filter(value => typeof value === 'string' && value))].sort();
      options(controls[property], [['', any], ...values.map(value => [value, label(value)])], state.filters[property]);
    }
  }
  async function reload() {
    if (state.disposed) return;
    if (state.busy) { state.reloadAfter = true; return; }
    const requested = week().weekStart, request = ++state.request;
    state.loading = true; state.error = ''; paint();
    try {
      const data = await api.mealLibrary(requested);
      if (state.disposed || request !== state.request) return;
      if (week().weekStart !== requested) { state.loading = false; return reload(); }
      if (state.loadedWeek !== requested) { state.seen.clear(); state.undo = null; state.targets.clear(); }
      state.loadedWeek = requested; state.data = data; state.conflict = false;
      refreshFacets();
    } catch (error) { if (!state.disposed && request === state.request) state.error = error.message || 'Meal ideas could not load.'; }
    finally { if (!state.disposed && request === state.request) { state.loading = false; paint(); } }
  }
  async function act(operation, focusDeck = false) {
    if (unavailable() || state.disposed) return;
    state.busy = true; state.error = ''; state.notice = ''; paint();
    try { await operation(); }
    catch (error) {
      if (!state.disposed) {
        state.error = error.message || 'Your choice could not be saved. Try again.';
        if (error.status === 409 || /changed on another|stale|reload/i.test(state.error)) state.conflict = true;
      }
    } finally {
      if (!state.disposed) {
        state.busy = false; state.focusDeck = focusDeck; paint();
        if (state.reloadAfter) { state.reloadAfter = false; await reload(); }
      }
    }
  }
  function priorChoice(id) { return saved().has(id) ? 'favorite' : skipped().has(id) ? 'skip' : 'clear'; }
  function taste(recipe, action) {
    const id = key(recipe), previous = priorChoice(id), inDeck = state.mode === 'swipe';
    return act(async () => {
      const response = await api.saveMealTaste({ recipeId: id, action, expectedRevision: state.data.revision ?? null });
      if (state.disposed) return;
      Object.assign(state.data, response); state.undo = { id, previous, title: recipe.title };
      if (inDeck) state.seen.add(id);
      state.notice = action === 'favorite' ? `Saved ${recipe.title}.` : action === 'skip' ? `Skipped ${recipe.title}.` : `Removed ${recipe.title} from saved ideas.`;
    }, inDeck);
  }
  function undo() {
    if (!state.undo) return;
    const previous = state.undo;
    return act(async () => {
      const response = await api.saveMealTaste({ recipeId: previous.id, action: previous.previous, expectedRevision: state.data.revision ?? null });
      if (state.disposed) return;
      Object.assign(state.data, response); state.seen.delete(previous.id); state.undo = null;
      state.notice = `Undid your choice for ${previous.title}.`;
    }, state.mode === 'swipe');
  }
  function add(recipe) {
    const issue = addIssue();
    if (issue) { state.error = issue; paint(); return; }
    const current = { ...week() }, day = state.targets.get(key(recipe)) ?? 0, target = days(current.weekStart)[day];
    if (!slots.includes(recipe.slot) || !target?.date) return;
    return act(async () => {
      const response = await api.addMealFromLibrary({ weekStart: current.weekStart, recipeId: key(recipe),
        mealId: `${day}-${recipe.slot}`, expectedRevision: current.week?.revision ?? null });
      if (state.disposed) return;
      if (week().weekStart === current.weekStart) await onWeekUpdated(response);
      state.notice = `${recipe.title} added to ${target.label} ${recipe.slot}. Review your week to build the grocery list.`;
      state.reloadAfter = true;
    });
  }
  function details(recipe, photo) {
    const id = key(recipe);
    const panel = el('details', { class: 'md-recipe-details', open: state.expanded.has(id) }, [
      el('summary', { text: 'Recipe details' }),
      el('div', { class: 'md-recipe-body' }, [
        recipe.description ? el('p', { text: recipe.description }) : null,
        el('h4', { text: 'Ingredients · 1 serving' }),
        el('ul', {}, (recipe.ingredients || []).map(item => el('li', { text: `${item.quantity ?? ''} ${item.unit || ''} ${item.name || ''}`.trim() }))),
        el('h4', { text: 'Make it' }), el('ol', {}, (recipe.steps || []).map(step => el('li', { text: step }))),
        recipe.reason ? el('p', { class: 'md-reason', text: recipe.reason }) : null,
        ...(Array.isArray(recipe.healthNotes) ? recipe.healthNotes : recipe.healthNotes ? [recipe.healthNotes] : []).map(value => el('p', { class: 'md-reason', text: value })),
        ...((recipe.basisIds || []).map(id => (state.data?.sources || []).find(source => source.id === id || source.ref === id)).filter(Boolean)).map(source => {
          const id = source.id || source.ref || '', href = id.startsWith('profile:') ? '#/health/profile' : id.startsWith('lab:') ? '#/health/labs' : null;
          return el('p', { class: 'md-reason' }, ['Based on ', el(href ? 'a' : 'span', { ...(href ? { href } : {}), text: source.title || source.label || id })]);
        }),
        mealPhotoCredit(photo),
      ]),
    ]);
    panel.addEventListener('toggle', () => { if (panel.open) state.expanded.add(id); else state.expanded.delete(id); });
    return panel;
  }
  function card(recipe, swipe = false) {
    const id = key(recipe), favorite = saved().has(id), photo = mealPhoto(recipe), issue = addIssue();
    const day = el('select', { class: 'input', 'aria-label': `Day for ${recipe.title}`, dataset: { discoveryFocus: `day:${id}` },
      onchange: event => state.targets.set(id, Number(event.target.value)) }, days(week().weekStart).map(value => el('option', { value: value.index, text: `${value.label} · ${label(recipe.slot)}` })));
    day.value = String(state.targets.get(id) ?? 0);
    const article = el('article', { class: `md-card${swipe ? ' md-swipe-card' : ''}`, ...(swipe ? { tabindex: '0', 'aria-label': `${recipe.title}. Right arrow saves; left arrow skips.` } : {}) }, [
      mealPhotoFigure(photo),
      el('div', { class: 'md-card-body' }, [
        el('div', { class: 'md-card-heading' }, [el('div', {}, [el('p', { class: 'md-eyebrow', text: [label(recipe.slot), recipe.cuisine].filter(Boolean).join(' · ') }),
          el('h3', { text: recipe.title })]), button(favorite ? '♥' : '♡', { class: 'md-heart', 'aria-label': `${favorite ? 'Unsave' : 'Save'} ${recipe.title}`,
          'aria-pressed': String(favorite), disabled: unavailable(), dataset: { discoveryFocus: `heart:${id}` }, onClick: () => taste(recipe, favorite ? 'clear' : 'favorite') })]),
        el('div', { class: 'md-meta' }, [el('span', { text: Number.isFinite(recipe.minutes) ? `${recipe.minutes} min` : 'Time not listed' }),
          el('span', { text: estimate(recipe) })]),
        el('p', { class: 'md-origin', text: recipe.origin === 'local-ai' ? 'Local AI suggestion' : 'Recipe library' }),
        el('div', { class: 'md-tags' }, tags(recipe).slice(0, 3).map(tag => el('span', { text: label(tag) }))),
        details(recipe, photo),
        el('div', { class: 'md-add' }, [day, button('Add to week', { class: 'btn md-add-button', disabled: unavailable() || !!issue,
          'aria-label': `Add ${recipe.title} to week`, dataset: { discoveryFocus: `add:${id}` }, onClick: () => add(recipe) })]),
      ]),
    ]);
    if (swipe) gestures(article, recipe);
    return article;
  }
  function gestures(node, recipe) {
    let start = null;
    const reset = () => { start = null; node.style.setProperty('--swipe-x', '0px'); node.style.setProperty('--swipe-angle', '0deg'); };
    node.addEventListener('pointerdown', event => {
      if (unavailable() || event.isPrimary === false || event.button > 0 || event.target.closest?.('button,input,select,textarea,a,summary,details')) return;
      start = { x: event.clientX, y: event.clientY, id: event.pointerId, horizontal: false };
    });
    node.addEventListener('pointermove', event => {
      if (!start || start.id !== event.pointerId) return;
      const dx = event.clientX - start.x, dy = event.clientY - start.y;
      if (!start.horizontal && Math.abs(dy) > 16 && Math.abs(dy) > Math.abs(dx)) { reset(); return; }
      if (Math.abs(dx) > 18 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        start.horizontal = true; event.preventDefault();
        try { node.setPointerCapture?.(event.pointerId); } catch {}
        node.style.setProperty('--swipe-x', `${Math.max(-160, Math.min(160, dx))}px`);
        node.style.setProperty('--swipe-angle', `${Math.max(-5, Math.min(5, dx / 30))}deg`);
      }
    });
    node.addEventListener('pointerup', event => {
      if (!start || start.id !== event.pointerId) return;
      const dx = event.clientX - start.x, dy = event.clientY - start.y;
      const choose = start.horizontal && Math.abs(dx) >= 80 && Math.abs(dx) > Math.abs(dy) * 1.5;
      try { node.releasePointerCapture?.(event.pointerId); } catch {}
      reset(); if (choose) taste(recipe, dx > 0 ? 'favorite' : 'skip');
    });
    node.addEventListener('pointercancel', reset); node.addEventListener('lostpointercapture', reset);
  }
  root.addEventListener('keydown', event => {
    if (state.disposed || !root.isConnected || state.mode !== 'swipe' || unavailable() || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
      || event.target.closest?.('input,select,textarea,[contenteditable="true"]')) return;
    const recipe = visible()[0];
    if (recipe && ['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); taste(recipe, event.key === 'ArrowRight' ? 'favorite' : 'skip'); }
  });
  function paint() {
    if (state.disposed) return;
    const focus = content.contains(document.activeElement) ? document.activeElement?.dataset?.discoveryFocus : null;
    const recipes = visible(), count = Object.entries(state.filters).filter(([name, value]) => value && name !== 'sort');
    root.dataset.mode = state.mode; root.setAttribute('aria-busy', String(state.loading));
    for (const [mode, node] of modeButtons) { node.setAttribute('aria-pressed', String(mode === state.mode)); }
    filterCount.textContent = count.length ? `${count.length} active` : 'Filters';
    chips.replaceChildren(...count.map(([name, value]) => button(`${name === 'price' ? 'Up to $' : name === 'minutes' ? 'Under ' : ''}${label(value)}${name === 'minutes' ? ' min' : ''} ×`, {
      class: 'md-chip', 'aria-label': `Clear ${name} filter`, onClick: () => { controls[name].value = ''; filter(name, ''); },
    })));
    info.textContent = [...new Set([...(state.data?.warnings || []), addIssue()].filter(Boolean))].join(' ');
    info.hidden = !info.textContent;
    aboutText.textContent = state.data?.note || 'Prices are approximate ingredient costs per serving, not live store quotes.';
    status.textContent = state.error || state.notice || (state.loading ? 'Finding meal ideas…' : ''); status.hidden = !status.textContent;
    status.dataset.error = String(!!state.error);
    results.textContent = state.mode === 'swipe' ? `${recipes.length} ${state.replay ? 'skipped ' : ''}${recipes.length === 1 ? 'idea' : 'ideas'} to explore`
      : `${recipes.length} ${state.mode === 'saved' ? 'saved ' : ''}${recipes.length === 1 ? 'idea' : 'ideas'}`;
    if (state.mode === 'swipe' && recipes.length) {
      const recipe = recipes[0];
      content.replaceChildren(el('div', { class: 'md-deck' }, [
        el('p', { class: 'md-swipe-hint', text: 'Swipe right to save · left to pass' }), card(recipe, true),
        el('div', { class: 'md-swipe-actions' }, [
          button('Pass', { class: 'md-pass', disabled: unavailable(), 'aria-label': `Skip ${recipe.title}`, onClick: () => taste(recipe, 'skip') }),
          button('Save recipe', { class: 'md-save', disabled: unavailable(), 'aria-label': `Save recipe ${recipe.title}`, onClick: () => taste(recipe, 'favorite') }),
        ]),
      ]));
    } else if (recipes.length) content.replaceChildren(el('div', { class: 'md-grid' }, recipes.slice(0, state.limit).map(recipe => card(recipe))));
    else content.replaceChildren(el('div', { class: 'md-empty' }, [
      el('h3', { text: state.loading && !state.data ? 'A little inspiration is on its way' : state.mode === 'saved' ? 'Your favorites will live here' : state.mode === 'swipe' ? 'You’ve reached the end of this deck' : 'No ideas match these filters' }),
      el('p', { text: state.mode === 'saved' ? 'Save a recipe in Browse or Swipe, or loosen your filters.' : 'Try fewer filters, browse all ideas, or replay recipes you skipped.' }),
    ]));
    more.hidden = state.mode === 'swipe' || recipes.length <= state.limit;
    undoButton.hidden = !state.undo; undoButton.disabled = unavailable();
    replayButton.hidden = !(state.data?.skipped || []).length; replayButton.disabled = state.busy || state.loading;
    refreshButton.disabled = state.busy || state.loading; resetButton.hidden = !count.length && state.filters.sort === 'recommended';
    if (focus) focusQuietly([...content.querySelectorAll('button,select')].find(node => node.dataset.discoveryFocus === focus));
    if (state.focusDeck) { focusQuietly(content.querySelector('.md-swipe-card')); state.focusDeck = false; }
  }
  reload();
  return { root, reload, dispose() { state.disposed = true; state.request++; } };
}
