/** Weekly meal choices; all records and inference stay on the private Zelos server. */
import { el, button, focusQuietly } from './dom.js';
import { api } from './api.js';
import { mealPhoto, mealPhotoFigure, mealPhotoCredit } from './meal-photos.js';
import { createMealDiscovery } from './meal-discovery.js';
const slots = ['breakfast', 'lunch', 'dinner'];
const label = value => value[0].toUpperCase() + value.slice(1);
const date = value => new Date(`${value}T12:00:00`);
const dateText = (value, options) => date(value).toLocaleDateString(undefined, options);
export function defaultMealWeek() { const d = new Date(); const weekend = d.getDay() === 0 || d.getDay() === 6; d.setDate(d.getDate() - (d.getDay() + 6) % 7 + (weekend ? 7 : 0)); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function shift(value, days) { const d = date(value); d.setDate(d.getDate() + days); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
const note = text => el('p', { class: 'shopping-note', text });
const money = (minor, currency) => { try { return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(minor / 100); } catch { return `${(minor / 100).toFixed(2)} ${currency}`; } };
const range = (low, high, currency) => `${money(low, currency)}–${money(high, currency)}`;
const field = (name, control) => el('label', { class: 'shopping-field' }, [el('span', { text: name }), control]);
function input(name, value, onInput, props = {}) { return el('input', { class: 'input', 'aria-label': name, value: value ?? '', oninput: event => onInput(event.target.value), ...props }); }
function select(name, options, value, onChange, disabled) { const node = el('select', { class: 'input', 'aria-label': name, disabled, onchange: event => onChange(event.target.value) }, options.map(([id, text]) => el('option', { value: id, text }))); node.value = String(value); return node; }

export function createMealPlanner({ onListBuilt = async () => {}, onWeekChange = () => {}, initialView = 'week' } = {}) {
  const root = el('section', { class: 'meal-planner', 'aria-label': 'Weekly meal planner' });
  const state = { view: initialView === 'discover' ? 'discover' : 'week', weekStart: defaultMealWeek(), data: null, busy: false, error: '', notice: '', day: 0, selected: new Set(), choices: {}, dirty: false, preferences: null, preferencesDirty: false, preferencesOpen: false, conflict: false, storeDraft: null, storeDraftRevision: null, storesDirty: false, storesOpen: false, maxMinutes: 45, instructions: '', timer: null, loading: false };
  let discovery = null;
  function discoveryPanel() {
    if (!discovery) discovery = createMealDiscovery({
      getWeek: () => ({ weekStart: state.weekStart, week: state.data?.week, profile: state.data?.profile, stale: state.data?.stale, dirty: state.dirty, preferencesDirty: state.preferencesDirty, locked: locked() || state.loading }),
      onWeekUpdated: async data => {
        if (data.week?.weekStart !== state.weekStart) return;
        adopt(data); state.notice = state.conflict ? 'The meal was saved in Zelos. Your newer unsaved choices were kept for review.' : 'Meal added to your week. Build the grocery list when your choices are ready.'; paint();
      },
      onViewWeek: () => { state.view = 'week'; paint(); },
    });
    return discovery.root;
  }
  const running = () => state.data?.job?.status === 'running';
  const locked = () => state.busy || running();
  const currentMeals = () => (state.data?.week?.meals || []).map(m => ({ ...m, recipeId: state.choices[m.id] || m.recipeId }));
  const recipeFor = meal => state.data.week.recipes.find(r => r.id === meal.recipeId);
  function schedulePoll() { clearTimeout(state.timer); if (running()) { state.timer = setTimeout(() => load(false), 2500); state.timer.unref?.(); } }
  function adopt(data, reset = false) {
    const changed = data.week?.id !== state.data?.week?.id || data.week?.revision !== state.data?.week?.revision;
    if (changed && state.data?.week && state.dirty && !reset) {
      state.conflict = true; state.error = 'Your week changed on another device. Reload the current week before saving these choices.';
      data = { ...data, week: state.data.week };
    } else if (reset || !state.dirty) state.conflict = false;
    state.data = data;
    if (reset || (changed && !state.dirty)) { state.selected = new Set(data.week?.selectedIds || []); state.choices = {}; state.dirty = false; }
    if (!state.preferencesDirty) state.preferences = { ...data.profile };
    if (!state.storesDirty) { state.storeDraft = (data.storePreferences?.stores || []).map(store => store.id); state.storeDraftRevision = data.storePreferences?.revision ?? null; }
    if (reset && data.week) { state.maxMinutes = data.week.maxMinutes; state.instructions = data.week.instructions; }
  }
  async function load(reset = false) {
    if (state.loading) return; state.loading = true;
    const requested = state.weekStart;
    try { const data = await api.mealWeek(requested); if (requested !== state.weekStart) return; state.error = ''; adopt(data, reset); }
    catch (error) { state.error = error.message; }
    finally { state.loading = false; if (requested !== state.weekStart) { load(true); } else { const existingDiscovery = discovery; paint(); schedulePoll(); if (!running()) existingDiscovery?.reload(); } }
  }
  async function act(fn) { if (state.busy) return; state.busy = true; state.error = ''; state.notice = ''; paint(); try { await fn(); } catch (error) { state.error = error.message; } finally { state.busy = false; paint(); schedulePoll(); } }
  async function savePreferences() {
    const p = state.preferences;
    const result = await api.saveHealthProfile({ goals: p.goals || '', diet: p.diet || '', allergies: p.allergies || '', householdSize: Number(p.householdSize), weeklyBudget: p.weeklyBudget === '' ? null : p.weeklyBudget, currency: p.currency, expectedUpdatedAt: state.data.profile.updatedAt });
    state.preferencesDirty = false; state.preferences = { ...result.profile }; state.data.profile = result.profile;
  }
  async function generate() {
    await act(async () => {
      if (state.preferencesDirty) await savePreferences();
      if (state.storesDirty) await saveStores();
      const data = await api.generateMealWeek({ weekStart: state.weekStart, servings: Number(state.preferences.householdSize), maxMinutes: Number(state.maxMinutes), instructions: state.instructions, expectedRevision: state.data.week?.revision || null });
      state.dirty = false; adopt(data, true); state.preferencesOpen = false; state.view = 'week';
    });
  }
  async function build() {
    if (state.preferencesDirty || state.conflict) { state.error = state.conflict ? 'Your week changed on another device. Reload the current week before saving.' : 'Save your meal preferences and generate fresh ideas before building the list.'; paint(); return; }
    await act(async () => {
      const week = state.data.week;
      const result = await api.buildMealGroceries({ weekStart: state.weekStart, weekId: week.id, expectedRevision: week.revision, selectedIds: [...state.selected], choices: state.choices });
      state.dirty = false; adopt({ ...state.data, week: result.week }, true);
      state.notice = `${state.selected.size} ${state.selected.size === 1 ? 'meal' : 'meals'} saved. ${result.groceryCount} combined ingredients in your grocery list.`;
      await onListBuilt();
    });
  }
  async function saveStores() {
    const result = await api.saveGroceryStores({ storeIds: [...state.storeDraft], expectedRevision: state.storeDraftRevision });
    state.data.storePreferences = result; state.storeDraft = result.stores.map(s => s.id); state.storeDraftRevision = result.revision; state.storesDirty = false; state.storesOpen = false;
  }
  function storesPanel() {
    const saved = state.data.storePreferences;
    return el('div', { class: 'meal-stores' }, [
      el('div', { class: 'meal-stores-heading' }, [el('div', { class: 'meal-store-summary' }, [el('span', { class: 'meal-store-label', text: 'Your stores' }), ...(saved.stores.length ? saved.stores.map(store => el('span', { class: 'meal-store-chip', text: store.name })) : [note('Choose where you shop')])]),
        button(state.storesOpen ? 'Close' : 'Edit stores', { class: 'btn quiet', disabled: locked(), onClick: () => { state.storesOpen = !state.storesOpen; paint(); } })]),
      state.storesOpen ? el('div', { class: 'meal-stores-editor' }, [
        el('div', { class: 'meal-store-options', role: 'group', 'aria-label': 'Your grocery stores' }, saved.availableStores.map(store => {
          const selected = state.storeDraft.includes(store.id);
          return button(store.name, { class: `meal-store-option ${selected ? 'is-selected' : ''}`, 'aria-pressed': String(selected), 'aria-label': `Shop at ${store.name}`, disabled: locked(), id: `meal-store-${store.id}`, onClick: () => { state.storeDraft = selected ? state.storeDraft.filter(id => id !== store.id) : [...state.storeDraft, store.id]; state.storesDirty = true; paint(`meal-store-${store.id}`); } });
        })),
        note('New meal ideas will use your preferred stores. Prices stay approximate; store selection does not connect an account.'),
        el('div', { class: 'shopping-actions' }, [button('Save stores', { class: 'btn solid', disabled: locked() || !state.storesDirty, onClick: () => act(async () => { await saveStores(); state.notice = 'Your stores are saved. New meal ideas will use them.'; }) }),
          button('Reset changes', { class: 'btn quiet', disabled: locked() || !state.storesDirty, onClick: () => { state.storeDraft = saved.stores.map(s => s.id); state.storeDraftRevision = saved.revision; state.storesDirty = false; paint(); } })]),
      ]) : null,
    ]);
  }
  function preferences() {
    const p = state.preferences;
    const update = key => value => { p[key] = value; state.preferencesDirty = true; };
    const panel = el('details', { class: 'meal-preferences', open: state.preferencesOpen }, [
      el('summary', {}, [el('span', { text: 'Meal preferences' }), el('span', { class: 'meal-preference-summary', text: `${p.householdSize || 1} ${(Number(p.householdSize) || 1) === 1 ? 'person' : 'people'} · Up to ${state.maxMinutes} min` })]),
      el('div', { class: 'meal-preferences-body' }, [
        el('div', { class: 'meal-form-grid' }, [
          field('Servings per meal', input('Servings per meal', p.householdSize, update('householdSize'), { type: 'number', min: 1, max: 20, step: 1, disabled: locked() })),
          field('Cooking time', select('Maximum cooking time', [15, 30, 45, 60, 90, 120].map(v => [v, `Up to ${v} minutes`]), state.maxMinutes, value => { state.maxMinutes = Number(value); }, locked())),
          field('Weekly grocery budget', input('Weekly grocery budget', p.weeklyBudget, update('weeklyBudget'), { type: 'number', min: 0, max: 1000000, step: .01, placeholder: 'Optional', disabled: locked() })),
          field('Currency', select('Meal currency', [...new Set([p.currency, 'USD', 'CAD', 'GBP', 'EUR'])].map(v => [v, v]), p.currency, update('currency'), locked())),
          field('Food preferences & foods to avoid', input('Food preferences & foods to avoid', p.diet, update('diet'), { placeholder: 'e.g. vegetarian, no mushrooms', maxlength: 4000, disabled: locked() })),
          field('Food allergies', input('Food allergies', p.allergies, update('allergies'), { placeholder: 'List foods, or enter none', maxlength: 4000, disabled: locked() })),
          field('Your goals', input('Your goals', p.goals, update('goals'), { placeholder: 'e.g. balanced meals, easier cooking', maxlength: 4000, disabled: locked() })),
          field('Anything for this week?', input('Anything for this week?', state.instructions, value => { state.instructions = value; }, { placeholder: 'e.g. quick lunches, fewer dishes', maxlength: 1000, disabled: locked() })),
        ]),
        note('Food preferences, allergies, servings and budget are shared with Health. Time and this week’s notes apply to new meal ideas.'),
        button('Save preferences', { class: 'btn quiet', disabled: locked(), onClick: () => act(async () => { await savePreferences(); await load(); state.notice = 'Preferences saved. Generate new ideas to use these changes.'; }) }),
      ]),
    ]);
    panel.addEventListener('toggle', () => { state.preferencesOpen = panel.open; }); return panel;
  }
  function recipeCard(meal) {
    const week = state.data.week, recipe = recipeFor(meal), checked = state.selected.has(meal.id);
    const choose = button(checked ? 'Selected' : 'Add meal', { class: `meal-select ${checked ? 'is-selected' : ''}`, 'aria-pressed': String(checked), 'aria-label': `${checked ? 'Remove' : 'Add'} ${recipe.title} for ${meal.slot} on ${meal.date}`, disabled: locked(), onClick: () => { if (checked) state.selected.delete(meal.id); else state.selected.add(meal.id); state.dirty = true; paint(`meal-${meal.id}`); }, id: `meal-${meal.id}` });
    const photo = mealPhoto(recipe);
    const sources = recipe.basisIds.map(id => week.sources.find(s => s.id === id)).filter(Boolean);
    return el('article', { class: `meal-card ${checked ? 'is-selected' : ''}` }, [
      mealPhotoFigure(photo),
      el('div', { class: 'meal-card-top' }, [el('span', { class: 'meal-slot', text: label(meal.slot) }), choose]),
      el('h3', { text: recipe.title }), note(recipe.description),
      el('div', { class: 'meal-facts' }, [el('span', { text: `${recipe.minutes} min` }), el('span', { text: `~${range(recipe.costLow / week.servings, recipe.costHigh / week.servings, week.currency)} / serving` })]),
      week.servings > 1 ? note(`${range(recipe.costLow, recipe.costHigh, week.currency)} for ${week.servings} servings`) : null,
      el('div', { class: 'meal-reason' }, [el('span', { class: 'meal-reason-label', text: sources.length ? 'Chosen with your health in mind' : 'Everyday balance' }), el('p', { text: recipe.healthNotes?.length ? recipe.healthNotes.join(' ') : recipe.reason })]),
      el('details', { class: 'meal-recipe' }, [el('summary', { text: 'Recipe & ingredients' }), el('div', {}, [
        el('h4', { text: `Ingredients · ${week.servings} ${week.servings === 1 ? 'serving' : 'servings'}` }),
        el('ul', {}, recipe.ingredients.map(i => el('li', { text: `${i.quantity} ${i.unit} ${i.name}` }))),
        el('h4', { text: 'How to make it' }), el('ol', {}, recipe.steps.map(text => el('li', { text }))),
        mealPhotoCredit(photo),
        sources.length ? el('div', { class: 'meal-sources' }, [el('h4', { text: 'Saved information considered' }), ...sources.map(s => el('a', { href: s.href, text: `${s.title}${s.date ? ` · ${s.date}` : ''}` }))]) : null,
      ])]),
      select(`Swap ${meal.slot} on ${meal.date}`, week.recipes.filter(r => r.slot === meal.slot).map(r => [r.id, r.id === recipe.id ? 'Swap meal…' : r.title]), recipe.id, id => { state.choices[meal.id] = id; state.dirty = true; paint(); requestAnimationFrame(() => focusQuietly(root.querySelector(`[aria-label="Swap ${meal.slot} on ${meal.date}"]`))); }, locked()),
    ]);
  }
  function plannerBody() {
    const week = state.data.week;
    if (!week) return el('div', { class: 'meal-empty' }, [el('span', { class: 'meal-empty-mark', 'aria-hidden': 'true' }), el('h2', { text: 'Your week, made easier.' }), note('Breakfast, lunch and dinner ideas built around you. Pick what sounds good and Zelos will gather the ingredients.'), el('div', { class: 'meal-empty-steps' }, [el('span', { text: '01  Get meal ideas' }), el('span', { text: '02  Choose your favorites' }), el('span', { text: '03  Build your list' })]), button(running() ? 'Planning your week…' : 'Plan my week', { class: 'btn solid', disabled: locked(), onClick: generate })]);
    const meals = currentMeals(), chosen = meals.filter(m => state.selected.has(m.id)), recipes = chosen.map(recipeFor);
    const costLow = recipes.reduce((s, r) => s + r.costLow, 0), costHigh = recipes.reduce((s, r) => s + r.costHigh, 0);
    const days = Array.from({ length: 7 }, (_, i) => shift(week.weekStart, i));
    return el('div', { class: 'meal-week' }, [
      el('div', { class: 'meal-week-top' }, [el('div', {}, [el('h2', { text: 'On the menu' }), note(`21 meal ideas · ${week.servings} ${week.servings === 1 ? 'serving' : 'servings'} each`)]), el('div', { class: 'shopping-actions' }, [button('Select all meals', { class: 'btn quiet', disabled: locked(), onClick: () => { state.selected = new Set(meals.map(m => m.id)); state.dirty = true; paint(); } }), button('Clear meals', { class: 'btn quiet', disabled: locked() || !chosen.length, onClick: () => { state.selected.clear(); state.dirty = true; paint(); } })])]),
      el('div', { class: 'meal-days', role: 'group', 'aria-label': 'Choose a meal day' }, days.map((d, i) => button([el('span', { text: dateText(d, { weekday: 'short' }) }), el('strong', { text: dateText(d, { day: 'numeric' }) }), el('span', { class: 'meal-day-count', text: `${chosen.filter(m => m.date === d).length}/3` })], { class: `meal-day ${state.day === i ? 'is-active' : ''}`, 'aria-pressed': String(state.day === i), 'aria-label': dateText(d, { weekday: 'long', month: 'long', day: 'numeric' }), onClick: () => { state.day = i; paint(`meal-day-${i}`); }, id: `meal-day-${i}` }))),
      el('div', { class: 'meal-cards' }, meals.filter(m => m.date === days[state.day]).map(recipeCard)),
      el('div', { class: 'meal-selection-summary', 'aria-live': 'polite' }, [el('div', {}, [el('strong', { text: `${chosen.length} ${chosen.length === 1 ? 'meal' : 'meals'} selected` }), note(chosen.length ? `${range(costLow, costHigh, week.currency)} estimated ingredients · ${recipes.reduce((s, r) => s + r.minutes, 0)} min of cooking across the week` : 'Add a meal to start your grocery list.')]), button(state.busy ? 'Saving…' : week.built ? 'Update grocery list' : 'Build grocery list', { class: 'btn solid', disabled: locked() || (!chosen.length && !week.built) || state.data.stale || state.preferencesDirty || state.conflict, onClick: build })]),
      note(week.priceNote),
      note('Photos are serving ideas. Ingredients and garnishes may differ; follow each recipe’s ingredient list.'),
      week.weeklyBudget != null ? note(`Weekly budget: ${money(week.weeklyBudget * 100, week.currency)}${costHigh > week.weeklyBudget * 100 ? ' · These estimates may exceed your budget. Try swapping meals.' : ''}`) : null,
      chosen.length ? el('details', { class: 'meal-selection-review' }, [el('summary', { text: 'See your selected week' }), ...days.map(d => el('div', { class: 'meal-selected-day' }, [el('strong', { text: dateText(d, { weekday: 'short', month: 'short', day: 'numeric' }) }), el('div', {}, meals.filter(m => m.date === d && state.selected.has(m.id)).map(m => note(`${label(m.slot)} · ${recipeFor(m).title}`)))]))]) : null,
    ]);
  }
  function paint(focusId) {
    const data = state.data;
    if (!data) { root.replaceChildren(note(state.error || 'Loading your meal planner…')); return; }
    const week = data.week;
    root.replaceChildren(
      el('div', { class: 'meal-planner-heading' }, [el('div', {}, [el('p', { class: 'meal-eyebrow', text: 'A WEEK OF GOOD FOOD' }), el('h2', { text: 'Meals for your week' })]), el('div', { class: 'meal-week-nav' }, [button('‹', { class: 'btn quiet', 'aria-label': 'Previous meal week', disabled: locked(), onClick: () => navigate(-7) }), el('span', { text: `${dateText(state.weekStart, { month: 'short', day: 'numeric' })} – ${dateText(shift(state.weekStart, 6), { month: 'short', day: 'numeric' })}` }), button('›', { class: 'btn quiet', 'aria-label': 'Next meal week', disabled: locked(), onClick: () => navigate(7) })])]),
      el('div', { class: 'meal-context-line' }, [el('span', { class: 'meal-local-dot', 'aria-hidden': 'true' }), el('span', { text: `Planned with your private library · ${data.health.labCount ? `${data.health.labCount} saved lab ${data.health.labCount === 1 ? 'result' : 'results'} available` : 'Uses your saved food preferences'}` }), el('a', { href: '#/health/profile', text: 'View health info' })]),
      ...(data.storePreferences ? [storesPanel()] : []),
      preferences(),
      ...(state.view === 'week' && !data.profile.allergies?.trim() ? [note('Allergies aren’t set yet. Add them in Meal preferences so Zelos can check your choices.')] : []),
      ...(state.error ? [el('p', { class: 'shopping-error', role: 'alert', text: state.error }), button('Reload current week', { class: 'btn quiet', disabled: locked(), onClick: () => { state.dirty = false; load(true); } })] : []),
      ...(state.notice ? [el('p', { class: 'shopping-notice', role: 'status', text: state.notice })] : []),
      ...(running() ? [el('div', { class: 'meal-progress', role: 'status' }, [el('span', { class: 'meal-spinner', 'aria-hidden': 'true' }), el('div', {}, [el('strong', { text: 'Your AI is planning your week' }), note('Choosing meals, combining ingredients and estimating costs. You can leave this page and come back.')]), button('Stop planning', { class: 'btn quiet', disabled: state.busy, onClick: () => act(async () => adopt(await api.cancelMealWeek(state.weekStart), true)) })])] : []),
      ...(!running() && ['failed', 'interrupted', 'cancelled'].includes(data.job?.status) ? [el('p', { class: 'shopping-error', role: 'status', text: data.job.error })] : []),
      ...(data.stale ? [el('p', { class: 'shopping-warning', text: 'Your health information has changed. Generate fresh meal ideas before updating this week’s grocery list.' })] : []),
      el('div', { class: 'meal-workspace-tabs', role: 'group', 'aria-label': 'Meal planning view' }, [
        button('Discover meals', { class: `meal-workspace-tab ${state.view === 'discover' ? 'is-active' : ''}`, 'aria-pressed': String(state.view === 'discover'), onClick: () => { const existingDiscovery = discovery; state.view = 'discover'; paint(); existingDiscovery?.reload(); } }),
        button(`Your week${week ? ` · ${state.selected.size}/21` : ''}`, { class: `meal-workspace-tab ${state.view === 'week' ? 'is-active' : ''}`, 'aria-pressed': String(state.view === 'week'), onClick: () => { state.view = 'week'; paint(); } }),
      ]),
      ...(state.view === 'discover' ? [discoveryPanel()] : [plannerBody()]),
      ...(week && state.view === 'week' ? [el('div', { class: 'meal-footer' }, [note(`Saved in Zelos · ${week.origin === 'library' ? 'Chosen from the library' : 'Generated'} ${dateText(week.createdAt.slice(0, 10), { month: 'short', day: 'numeric' })}`), button('Generate new ideas', { class: 'btn quiet', disabled: locked(), onClick: generate })])] : []),
      el('details', { class: 'meal-guidance' }, [el('summary', { text: 'About health & price estimates' }), note('Meals use your saved preferences and health records for general food choices. They do not diagnose conditions or prescribe treatment. Check product labels and cross-contact risks for allergies. Prices are rough ingredient estimates, not store quotes.'), ...(week?.guidance || []).map(s => el('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer', text: s.title }))]),
    );
    if (focusId) focusQuietly(root.querySelector(`#${focusId}`));
  }
  function navigate(days) { state.weekStart = shift(state.weekStart, days); state.day = 0; state.data = null; state.selected.clear(); state.choices = {}; state.dirty = false; state.notice = ''; onWeekChange(state.weekStart); paint(); load(true); }
  load(true); return { root, reload: () => load(false) };
}
