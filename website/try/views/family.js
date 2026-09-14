/** Read-only Family overview using the current app's visual components and fictional views. */
import {el, button} from '../lib/dom.js';
import {loadingState} from '../lib/loading.js';
import {request} from '../lib/api.js';

let root, state, person = 'alex', tab = 'overview', requestNumber = 0, error = '';
const note = text => el('p', {class:'family-note', text});
const badge = text => el('span', {class:'family-badge', text});
const actions = children => el('div', {class:'family-actions'}, children);
const section = (title, children, description) => el('section', {class:'family-panel'}, [el('h2', {text:title}), description && note(description), ...children]);
const name = id => state.members.find(member => member.id === id)?.name || 'Family member';
const dateLabel = value => new Date(value.slice(0, 10) + 'T12:00:00Z').toLocaleDateString(undefined, {month:'short', day:'numeric', year:'numeric', timeZone:'UTC'});
const demoButton = (label, onClick, props = {}) => button(label, {class:'family-button', onClick, ...props});
function recordCard(record) {
  const visibility = record.visibility === 'family' ? 'Family' : record.ownerId === state.me.id ? 'Only me' : 'Shared with you';
  return el('article', {class:'family-record'}, [
    el('div', {class:'family-row-head'}, [el('div', {}, [el('h3', {text:record.title}),
      note([record.kind[0].toUpperCase() + record.kind.slice(1), record.date && dateLabel(record.date), record.assigneeId && `Assigned to ${name(record.assigneeId)}`].filter(Boolean).join(' · '))]),
    el('div', {class:'family-badges'}, [badge(visibility), badge(record.status === 'done' ? 'Done' : record.kind === 'task' ? 'Open' : 'Saved')])]),
    el('p', {class:'family-record-details', text:record.details}),
    record.source && note(`Snapshot · ${record.source.label} · selected ${dateLabel(record.source.capturedAt)}. Changes to the original are not automatically shared.`),
  ]);
}
function overview() {
  const count = (value, label) => el('div', {class:'family-stat'}, [el('strong', {text:value}), el('span', {text:label})]);
  const tasks = state.records.filter(record => record.kind === 'task' && record.status !== 'done');
  const plans = state.records.filter(record => record.kind === 'plan' || record.kind === 'event');
  return [el('div', {class:'family-stats'}, [count(state.records.length, 'Visible records'), count(tasks.length, 'Open tasks'),
    count(plans.length, 'Plans & events'), count(state.children.length, 'Visible child profiles')]),
  state.children.length > 0 && section('Children', [el('div', {class:'family-children'}, state.children.map(child => el('article', {class:'family-child'}, [
    el('div', {class:'family-avatar', 'aria-hidden':'true', text:child.name[0]}), el('div', {class:'family-child-info'}, [el('h3', {text:child.name}),
      note(`Managed by ${child.guardianIds.map(name).join(' and ')}`), note(child.notes)]),
  ])))]),
  section('Your next steps', tasks.length ? tasks.map(recordCard) : [note('No open tasks in this sample view.')]),
  plans.length > 0 && section('Selected plans', plans.map(recordCard)),
  section('People in this view', state.members.map(member => el('div', {class:'family-member'}, [
    el('div', {}, [el('strong', {text:member.name + (member.id === state.me.id ? ' · You' : '')}),
      note(({owner:'Owner · separate account', parent:'Parent · separate account', collaborator:'Collaborator · selected access'})[member.role])]),
  ])), 'Joining a family does not expose another adult’s private records.')];
}
function accessView() {
  const children = state.grants.map(grant => el('article', {class:'family-record'}, [
    el('div', {class:'family-row-head'}, [el('div', {}, [el('h3', {text:grant.label}),
      note(`From ${grant.grantorName} to ${name(grant.accountId)} · expires ${dateLabel(grant.expiresAt)}`)]), badge('Sample access')]),
    note('View selected records. No task submissions, document uploads or direct task creation.'),
    note(`${grant.recordIds.length} selected task · future records excluded · no child profiles shared`),
    ...state.records.filter(record => grant.recordIds.includes(record.id)).map(recordCard),
  ]));
  return [section('Access, chosen person by person', children.length ? children : [note('No outside access is visible to this sample account.')],
    'The installed app lets you select records and permissions, set an expiry, preview what the recipient can see, and revoke access.'),
  section('Try the other sample views', [note('Switch the fictional person above. Jamie sees shared family records and Jamie’s own note. Sam sees only the selected Northstar task. Alex’s private reflection stays in Alex’s view.')])];
}
function paint() {
  if (!root) return;
  if (!state) {root.replaceChildren(error ? el('p', {class:'family-status is-error', role:'alert', text:error}) : loadingState('Loading the sample family…')); return;}
  const selector = el('select', {class:'family-input', 'aria-label':'Fictional person'}, state.demo.people.map(member => el('option', {value:member.id, text:`${member.name} · ${{owner:'owner',parent:'parent',collaborator:'collaborator'}[member.role]}`})));
  selector.value = person;
  selector.addEventListener('change', () => {person = selector.value; state = null; load();});
  root.replaceChildren(...[
    el('header', {class:'family-heading'}, [el('div', {}, [el('p', {class:'family-eyebrow', text:'YOUR PEOPLE, IN ONE PLACE'}),
      el('h1', {text:state.family.name}), note(state.me.role === 'collaborator' ? `Shared with ${state.me.name}. Just the records selected for this person.` : 'Plan together. Keep personal things personal.')])]),
    section('Explore a fictional household', [el('label', {class:'family-field'}, [el('span', {text:'View as'}), selector]),
      note('Switching people only changes this example view. No account is created and no sharing settings are changed.'),
      actions([demoButton('Invitations require the installed app', undefined, {disabled:true, title:'No invitations, links, credentials or external actions are created in the website demo.'})])]),
    el('nav', {class:'family-tabs', 'aria-label':'Family workspace'}, [['overview','Overview'],['records','Records'],['access','Access']].map(([id, label]) =>
      demoButton(label, () => {tab = id; paint();}, {class:`family-button ${tab === id ? 'is-active' : ''}`, 'aria-current':tab === id ? 'page' : null}))),
    el('div', {class:'family-privacy'}, [el('strong', {text:'Private by default. '}), el('span', {text:'These are selected fictional views. Actual account and record permissions are enforced by your installed Zelos.'})]),
    ...(tab === 'overview' ? overview() : tab === 'records' ? [section('Records visible to ' + state.me.name, state.records.map(recordCard), 'These selected snapshots do not publish your whole Today board or Health history.')] : accessView()),
  ].filter(Boolean));
}
async function load() {
  const number = ++requestNumber; error = ''; paint();
  try {const result = await request('/api/family?person=' + encodeURIComponent(person)); if (number === requestNumber) state = result;}
  catch (e) {if (number === requestNumber) error = e.message;}
  if (number === requestNumber) paint();
}
export function renderFamily() {
  if (!root) {root = el('div', {class:'view view-family family-app'}); load();}
  return root;
}
