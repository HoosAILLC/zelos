/** Local grocery review and explicitly approved Instacart shopping-list links. */
import { el, button, focusQuietly } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { disclosure } from '../lib/workspace.js';

const state = { root: null, data: null, selected: new Set(), title: 'My grocery list', review: null, busy: false, error: '', notice: '', loaded: false,
  settingsDraft: null, settingsDirty: false };
const note = value => el('p', { class: 'shopping-note', text: value });
const field = (label, control) => el('label', { class: 'shopping-field' }, [el('span', { text: label }), control]);
const input = (label, value = '', type = 'text') => el('input', { class: 'input', type, value, 'aria-label': label });
function select(label, options, value) {
  const node = el('select', { class: 'input', 'aria-label': label }, options.map(([key, name]) => el('option', { value: key, text: name })));
  node.value = value; return node;
}
const money = (minor, currency) => {
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(minor / 100); }
  catch { return `${(minor / 100).toFixed(2)} ${currency}`; }
};
async function load() {
  state.busy = true; state.error = ''; paint();
  try {
    const data = await api.shopping(), eligible = data.items.filter(item => item.state === 'needed').map(item => item.id);
    state.selected = new Set(state.loaded ? eligible.filter(id => state.selected.has(id)) : eligible);
    state.data = data; state.loaded = true;
    if (!state.settingsDirty) state.settingsDraft = { ...data.settings, apiKey: '' };
  } catch (error) { state.error = error.message; }
  finally { state.busy = false; paint(); }
}
async function act(operation, success) {
  if (state.busy) return;
  state.busy = true; state.error = ''; state.notice = ''; paint();
  try { await operation(); state.review = null; if (success) state.notice = success; await load(); }
  catch (error) { state.error = error.message; }
  finally { state.busy = false; paint(); }
}
function budgetSummary(totals) {
  return el('div', { class: 'shopping-budget' }, [
    el('div', {}, [el('span', { text: 'Entered estimates' }), el('strong', { text: money(totals.estimatedMinor, totals.currency) })]),
    el('div', {}, [el('span', { text: 'Weekly budget' }), el('strong', { text: totals.budgetMinor === null ? 'Not set' : money(totals.budgetMinor, totals.currency) })]),
    note(totals.unknownPrices ? `${totals.unknownPrices} items have no estimated price. ${totals.note}` : totals.note),
    totals.status === 'over_estimate' ? el('p', { class: 'shopping-warning', text: 'Your entered estimates already exceed the weekly budget.' }) : null,
    totals.budgetMinor === null ? el('a', { href: '#/health/profile', text: 'Add a grocery budget in Health → Goals & preferences' }) : null,
  ]);
}
function setup() {
  const settings = state.settingsDraft || state.data.settings;
  const controls = {
    provider: select('Grocery provider', [['', 'Choose provider'], ['instacart', 'Instacart']], settings.provider),
    environment: select('Connection type', [['production', 'Live Instacart'], ['development', 'Developer test']], settings.environment),
    countryCode: select('Country', [['', 'Choose country'], ['US', 'United States'], ['CA', 'Canada']], settings.countryCode),
    postalCode: input('Postal code', settings.postalCode),
    accountLabel: input('Instacart account reminder', settings.accountLabel),
    apiKey: input('Instacart developer API key', settings.apiKey || '', 'password'),
    retailerKey: select('Preferred store', [['', 'Choose a nearby store'], ...state.data.retailers.map(store => [store.key, store.name])], settings.retailerKey),
  };
  controls.apiKey.autocomplete = 'off';
  for (const [key, control] of Object.entries(controls)) {
    control.disabled = state.busy;
    control.addEventListener(control.tagName === 'SELECT' ? 'change' : 'input', () => {
      state.settingsDraft[key] = control.value; state.settingsDirty = true; state.review = null;
      state.root.querySelector('[aria-label="Review grocery sharing"]')?.remove();
    });
  }
  const save = async () => {
    const values = Object.fromEntries(Object.entries(controls).map(([key, node]) => [key, node.value]));
    values.expectedRevision = settings.revision;
    if (values.postalCode !== state.data.settings.postalCode || values.countryCode !== state.data.settings.countryCode || values.environment !== state.data.settings.environment) values.retailerKey = '';
    state.settingsDraft = { ...settings, ...values }; state.settingsDirty = true;
    const result = await api.saveShoppingSettings(values);
    state.settingsDirty = false;
    state.settingsDraft = { ...(result?.settings || state.data.settings), apiKey: '' };
    return result;
  };
  const panel = disclosure('shopping-connection', state.data.setupIssues.length ? 'Connect a store' : 'Store and connection settings', [
    note('An Instacart developer API key creates shopping-list links. Your Instacart login stays on Instacart; the account reminder below does not sign you in.'),
    el('div', { class: 'shopping-fields' }, [field('Grocery provider', controls.provider), field('Connection type', controls.environment),
      field('Country', controls.countryCode), field('Postal code', controls.postalCode), field('Instacart account reminder', controls.accountLabel),
      field(settings.keySaved ? 'API key saved — enter a new key to replace it' : 'Instacart developer API key', controls.apiKey), field('Preferred store', controls.retailerKey)]),
    el('div', { class: 'shopping-actions' }, [
      button('Save connection and store', { class: 'btn quiet', disabled: state.busy, onClick: () => act(save, 'Grocery preferences saved on Spark.') }),
      button('Find nearby stores', { class: 'btn quiet', disabled: state.busy, onClick: () => act(async () => { await save(); await api.shoppingStores({}); }, 'Nearby stores loaded. Choose one and save your preference.') }),
      el('a', { href: 'https://docs.instacart.com/developer_platform_api/get_started/api-keys', target: '_blank', rel: 'noopener noreferrer', text: 'Get a developer API key' }),
    ]),
    note(state.data.providerNote),
  ], {className:'shopping-setup'});
  return panel;
}
async function changeItem(item, value) {
  await act(() => api.setShoppingItemState({ id: item.id, state: value, expectedUpdatedAt: item.updatedAt }), 'Grocery status updated.');
}
function groceryGroup(group) {
  const checked = group.itemIds.every(id => state.selected.has(id));
  const check = el('input', { type: 'checkbox', 'aria-label': `Include ${group.name}`, disabled: state.busy }); check.checked = checked;
  check.indeterminate = !checked && group.itemIds.some(id => state.selected.has(id));
  check.addEventListener('change', () => { for (const id of group.itemIds) { if (check.checked) state.selected.add(id); else state.selected.delete(id); } state.review = null; paint(); });
  const rows = group.itemIds.map(id => state.data.items.find(item => item.id === id)).filter(Boolean);
  function statusControl(item) {
    const status = select(`Status of ${item.name}${item.mealTitle ? ` for ${item.mealTitle}` : ''}${item.quantity ? ` (${item.quantity})` : ''}`, [['needed', 'Needed'], ['have', 'Already have'], ['bought', 'Bought']], item.state);
    status.disabled = state.busy; status.addEventListener('change', () => changeItem(item, status.value));return status;
  }
  return el('article', { class: 'shopping-group' }, [
    el('div', { class: 'shopping-group-heading' }, [
      el('label', {}, [check, el('div',{},[el('strong', { text: group.name }),rows.length===1&&note(rows[0].mealTitle||rows[0].planTitle||'')])]),
      el('span', {class:'shopping-quantity', text: group.quantityText }), rows.length===1?statusControl(rows[0]):null,
    ]),
    rows.length>1?disclosure(`shopping-group-${group.itemIds.join('-')}`,`${rows.length} linked items`,rows.map(item=>el('div',{class:'shopping-source-row'},[
      el('div',{},[note([item.quantity,item.mealTitle||item.planTitle].filter(Boolean).join(' · ')),item.mealState==='skipped'?note('Related meal skipped. Check whether this item is needed.'):null]),statusControl(item),
    ]))):rows[0]?.mealState==='skipped'?note('Related meal skipped. Check whether this item is needed.'):null,
  ]);
}

async function prepare() {
  if (state.busy) return;
  if (state.settingsDirty) { state.error = 'Save your connection and store changes before reviewing a shopping list.'; paint(); return; }
  state.busy = true; state.error = ''; paint();
  try { state.review = await api.reviewShoppingList({ title: state.title, selectedIds: [...state.selected] }); }
  catch (error) { state.error = error.message; }
  finally { state.busy = false; paint(); if(state.review){const heading=state.root.querySelector('.shopping-review-title');focusQuietly(heading);heading?.scrollIntoView?.({block:'start'});} }
}
function reviewPanel() {
  const review = state.review;
  if (!review) return null;
  return el('section', { class: 'shopping-panel shopping-review', 'aria-label': 'Review grocery sharing' }, [
    el('h2', { class:'shopping-review-title',tabindex:-1,text: 'Review what Instacart will receive' }), el('h3', { text: review.title }),
    el('ul', {}, review.groups.map(group => el('li', { text: `${group.name} · ${group.quantityText}` }))),
    note(review.privacyNote), budgetSummary(review.totals),
    note(`Preferred store: ${review.storeName || 'Not selected'}. Account reminder: ${review.accountLabel || 'Not set'}. Confirm both on Instacart.`),
    review.environment === 'development' ? el('p', { class: 'shopping-warning', text: 'This is a developer test connection.' }) : null,
    ...review.issues.map(issue => el('p', { class: 'shopping-warning', text: issue })),
    el('div', { class: 'shopping-actions' }, [
      button('Create Instacart list', { class: 'btn', disabled: state.busy || !review.canCreate, onClick: () => act(async () => {
        const result = await api.createShoppingList({ title: review.title, selectedIds: review.selectedIds, reviewToken: review.reviewToken, approved: true });
        state.notice = result.message;
      }) }),
      button('Back to editing', { class: 'btn quiet', disabled: state.busy, onClick: () => { state.review = null; paint(); const title=state.root.querySelector('[aria-label="Shopping list title"]');focusQuietly(title);title?.scrollIntoView?.({block:'center'}); } }),
    ]),
    note('This shares a shopping list. It does not place an order or authorize a payment.'),
  ]);
}
function paint() {
  if (!state.root) return;
  const data = state.data;
  const nodes = [el('header', { class: 'shopping-heading' }, [el('div', {}, [el('h1', { text: 'Groceries' }), note('Your list, ready for the week.')]),
    el('div',{class:'workspace-actions'},[button(state.busy ? 'Working…' : 'Refresh', { class: 'btn quiet', disabled: state.busy, onClick: () => { state.review = null; load(); } }),el('a',{class:'btn solid',href:'#/health/groceries',text:'Add items'})])])];
  if (state.error) nodes.push(el('p', { class: 'shopping-error', role: 'alert', text: state.error }));
  if (state.notice) nodes.push(el('p', { class: 'shopping-notice', role: 'status', text: state.notice }));
  if (!data) { nodes.push(note(state.busy ? 'Loading saved groceries…' : 'Refresh to load your grocery list.')); state.root.replaceChildren(...nodes); return; }
  if(state.review){nodes.push(reviewPanel());state.root.replaceChildren(...nodes.filter(Boolean));return;}
  nodes.push(budgetSummary(data.totals));
  const title = input('Shopping list title', state.title); title.maxLength = 120;
  title.addEventListener('input', () => { state.title = title.value; state.review = null; state.root.querySelector('[aria-label="Review grocery sharing"]')?.remove(); });
  nodes.push(el('section', { class: 'shopping-panel' }, [
    el('div', { class: 'shopping-section-heading' }, [el('h2', { text: 'Needed groceries' }), note(`${data.groups.length} ${data.groups.length===1?'ingredient':'ingredients'}`)]),
    field('List title', title),
    ...(data.groups.length ? data.groups.map(groceryGroup) : [el('div', { class: 'shopping-empty' }, [el('h3', { text: 'Your grocery list is empty' }), note('Add ingredients to Health → Groceries and link them to a saved meal plan when useful.')])]),
    el('div', { class: 'shopping-actions' }, [
      button('Select needed', { class: 'btn quiet', disabled: state.busy, onClick: () => { state.selected = new Set(data.items.filter(item => item.state === 'needed').map(item => item.id)); state.review = null; paint(); } }),
      button('Clear selection', { class: 'btn quiet', disabled: state.busy, onClick: () => { state.selected.clear(); state.review = null; paint(); } }),
      button(`Review ${state.selected.size} selected ${state.selected.size === 1 ? 'item' : 'items'}`, { class: 'btn solid', disabled: state.busy || !state.selected.size, onClick: prepare }),
    ]),
  ]), reviewPanel());
  const done = data.items.filter(item => item.state !== 'needed');
  if (done.length) nodes.push(el('details', { class: 'shopping-panel' }, [el('summary', { text: `${done.length} items already have or bought` }),
    ...done.map(item => el('div', { class: 'shopping-source-row' }, [el('span', { text: `${item.name} · ${item.quantity} · ${item.state === 'have' ? 'Already have' : 'Bought'}` }),
      button('Need again', { class: 'btn quiet', disabled: state.busy, onClick: () => changeItem(item, 'needed') })]))]));
  if (data.lastResult?.status === 'list_created') nodes.push(el('section', { class: 'shopping-panel' }, [el('h2', { text: 'Last shopping list created' }),
    el('p', { text: data.lastResult.title }), note(data.lastResult.message),
    data.lastResult.changedSinceReview ? note('Your saved groceries changed while this link was being created. This link contains the version you approved.') : null,
    el('a', { class: 'btn quiet', href: data.lastResult.url, target: '_blank', rel: 'noopener noreferrer', text: 'Open list on Instacart' })]));
  nodes.push(setup(),note('Shopping lists only. Checkout and payment happen on Instacart.')); state.root.replaceChildren(...nodes.filter(Boolean));
}
export function renderShopping() {
  if (!state.root) { state.root = el('div', { class: 'view view-shopping' }); load(); }
  else if (!state.root.isConnected && !state.busy) { state.review = null; load(); }
  return state.root;
}
