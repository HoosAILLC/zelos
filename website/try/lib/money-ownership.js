import {el, button} from './dom.js';
import {cash} from './money-charts.js';

const OWNERS = {
  personal: {key: 'personal', label: 'Personal', color: '#7bd6c5'},
  business: {key: 'business', label: 'Business', color: '#b9a0ff'},
  unassigned: {key: 'unassigned', label: 'Unassigned', color: '#aab2bf'},
};
const ownerOf = entity => entity?.type === 'personal' ? 'personal' : entity?.type === 'company' ? 'business' : 'unassigned';
const add = (a, b) => {
  const value = a + b;
  if (!Number.isSafeInteger(value)) throw new Error('The selected totals are too large. Narrow the date range.');
  return value;
};
const emptyTotal = () => ({total: 0, moneyIn: 0, net: 0, count: 0});

/** Reuse the analysis scope; never combine currencies or reinterpret transfers. */
export function ownershipAnalysis(analysis, entities = []) {
  const entityMap = new Map(entities.map(entity => [entity.id, entity]));
  const owners = new Map(Object.values(OWNERS).map(owner => [owner.key, {...owner, ...emptyTotal()}]));
  const months = new Map(analysis.months.map(({month}) => [month, {month, total: 0, count: 0, personal: 0, business: 0, unassigned: 0}]));
  const workspaces = new Map();
  const summary = emptyTotal();
  for (const row of analysis.rows) {
    if (row.status === 'excluded' || row.kind === 'transfer' || row.amountCents === 0) continue;
    if (!Number.isSafeInteger(row.amountCents)) throw new Error('A recorded amount is invalid. Review the transactions.');
    const entity = entityMap.get(row.entityId), key = ownerOf(entity), owner = owners.get(key);
    const id = row.entityId ?? null;
    if (!workspaces.has(id)) workspaces.set(id, {
      id, name: entity?.name || 'Unassigned workspace', ...OWNERS[key], known: Boolean(entity), ...emptyTotal(),
    });
    const workspace = workspaces.get(id), amount = Math.abs(row.amountCents);
    for (const group of [summary, owner, workspace]) {
      const field = row.amountCents < 0 ? 'total' : 'moneyIn';
      group[field] = add(group[field], amount);
      if (row.amountCents < 0) group.count++;
    }
    if (row.amountCents < 0) {
      const month = months.get(row.date.slice(0, 7));
      if (!month) throw new Error('A recorded date is outside the selected period.');
      month[key] = add(month[key], amount);
      month.total = add(month.total, amount);
      month.count++;
    }
  }
  const finish = group => ({...group, net: add(group.moneyIn, -group.total), share: summary.total ? group.total / summary.total : 0});
  return {
    ...finish(summary),
    owners: [...owners.values()].filter(owner => owner.key !== 'unassigned' || owner.total || owner.moneyIn).map(finish),
    months: [...months.values()],
    workspaces: [...workspaces.values()].map(finish).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name)),
  };
}

const muted = text => el('p', {class: 'money-muted', text});
const card = (kind, title, subtitle, children) => el('section', {class: `money-card money-owner-card money-owner-${kind}`}, [
  el('div', {class: 'money-card-head'}, el('div', {}, [el('h2', {text: title}), muted(subtitle)])), ...children,
]);
const props = owner => ({'data-owner': owner.key, style: {'--owner-color': owner.color}});
const dot = owner => el('i', {class: 'money-owner-dot', 'aria-hidden': 'true', ...props(owner)});
const shareLabel = share => `${(share * 100).toFixed(1)}%`;
const shortCash = (amount, currency) => new Intl.NumberFormat(undefined, {style: 'currency', currency, notation: 'compact', maximumFractionDigits: 1}).format(amount / 100);
const monthLabel = month => new Date(`${month}-01T12:00:00Z`).toLocaleDateString(undefined, {month: 'short', year: '2-digit', timeZone: 'UTC'});
function svg(tag, attributes, children = []) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  for (const child of children) node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  return node;
}
const legend = owners => el('div', {class: 'money-owner-key'}, owners.map(owner => el('span', props(owner), [dot(owner), owner.label])));

export function ownershipSplit(summary, currency = 'USD', onScope = () => {}) {
  const radius = 76, circumference = 2 * Math.PI * radius;
  const ring = svg('svg', {viewBox: '0 0 220 220', class: 'money-owner-ring', role: 'img',
    'aria-label': `Spending split. ${summary.owners.map(owner => `${owner.label}: ${cash(owner.total, currency)}, ${shareLabel(owner.share)}`).join('; ')}`});
  ring.appendChild(svg('circle', {cx: 110, cy: 110, r: radius, fill: 'none', stroke: 'currentColor', 'stroke-opacity': '.08', 'stroke-width': 22}));
  let offset = 0;
  for (const owner of summary.owners.filter(owner => owner.total > 0)) {
    const length = owner.share * circumference;
    ring.appendChild(svg('circle', {cx: 110, cy: 110, r: radius, fill: 'none', stroke: owner.color, 'stroke-width': 22,
      'stroke-dasharray': `${length} ${circumference - length}`, 'stroke-dashoffset': -offset, transform: 'rotate(-90 110 110)'}));
    offset += length;
  }
  ring.appendChild(svg('text', {x: 110, y: 108, 'text-anchor': 'middle', class: 'money-owner-ring-total'}, [shortCash(summary.total, currency)]));
  ring.appendChild(svg('text', {x: 110, y: 132, 'text-anchor': 'middle', class: 'money-axis'}, ['total spending']));
  const labels = el('div', {class: 'money-owner-legend'}, summary.owners.map(owner => button([
    dot(owner), el('span', {class: 'money-owner-name', text: owner.label}),
    el('small', {class: 'money-owner-share', text: shareLabel(owner.share)}),
    el('strong', {class: 'money-owner-amount', text: cash(owner.total, currency)}),
  ], {class: 'money-owner-legend-row', ...props(owner), disabled: owner.key === 'unassigned',
    'aria-label': `${owner.label}: ${cash(owner.total, currency)}, ${shareLabel(owner.share)} of spending${owner.key === 'unassigned' ? '' : '. View finances.'}`,
    onClick: () => onScope(owner.key)})));
  return card('split', 'Personal & business', 'Your spending split · select a side to explore.', [
    el('div', {class: 'money-owner-split-body'}, [ring, labels]),
    !summary.total && muted('No spending recorded in this period.'),
    summary.owners.some(owner => owner.key === 'unassigned') && muted('Unassigned records have no recognized personal or business workspace.'),
  ]);
}

export function ownershipMonthly(summary, currency = 'USD', onMonth = () => {}) {
  const max = Math.max(1, ...summary.months.map(month => month.total));
  return card('monthly', 'Spending over time', 'Personal and business together, month by month.', [
    legend(summary.owners),
    el('div', {class: 'money-owner-months'}, summary.months.map(month => {
      const label = monthLabel(month.month);
      const description = `${label}: ${cash(month.total, currency)} total; ${summary.owners.map(owner => `${owner.label} ${cash(month[owner.key], currency)}`).join('; ')}. ${month.count} purchases. View month.`;
      return button([
        el('span', {class: 'money-owner-month-value', text: month.total ? shortCash(month.total, currency) : '—'}),
        el('span', {class: 'money-owner-month-track', 'aria-hidden': 'true'}, summary.owners.map(owner => el('span', {
          class: 'money-owner-month-segment', 'data-owner': owner.key,
          style: {'--owner-color': owner.color, height: `${month[owner.key] / max * 100}%`},
        }))),
        el('span', {class: 'money-owner-month-label', text: label}),
      ], {class: 'money-owner-month', 'aria-label': description, title: description, onClick: () => onMonth(month.month)});
    })),
    muted('Recorded purchases only. Transfers and excluded duplicates do not count.'),
  ]);
}

export function ownershipFlow(summary, currency = 'USD') {
  const max = Math.max(1, ...summary.owners.flatMap(owner => [owner.total, owner.moneyIn]));
  return card('flow', 'Money in, money out', 'Compare recorded inflows and spending for each side.', [
    el('div', {class: 'money-owner-flow-list'}, summary.owners.map(owner => el('div', {class: 'money-owner-flow-row', ...props(owner)}, [
      el('div', {class: 'money-owner-flow-head'}, [
        el('strong', {}, [dot(owner), owner.label]),
        el('span', {class: 'money-owner-net', text: `Net ${cash(owner.net, currency)}`}),
      ]),
      ...[['Money in', owner.moneyIn, ' is-inflow'], ['Spending', owner.total, '']].map(([label, amount, className]) => el('div', {class: `money-owner-flow-lane${className}`}, [
        el('div', {class: 'money-owner-flow-label'}, [el('span', {text: label}), el('strong', {text: cash(amount, currency)})]),
        el('div', {class: 'money-owner-track', 'aria-hidden': 'true'}, el('span', {class: 'money-owner-fill', style: {width: `${amount / max * 100}%`}})),
      ])),
    ]))),
    muted('Money in includes recorded credits and refunds. Net is money in minus spending, not an account balance.'),
  ]);
}

export function ownershipWorkspaces(summary, currency = 'USD', onEntity = () => {}) {
  const max = Math.max(1, ...summary.workspaces.map(workspace => workspace.total));
  return card('workspaces', 'Spending by workspace', 'See how your companies and personal spending compare.', [
    el('div', {class: 'money-owner-workspace-list'}, summary.workspaces.map(workspace => button([
      el('span', {class: 'money-owner-workspace-head'}, [el('strong', {}, [dot(workspace), workspace.name]), el('strong', {text: cash(workspace.total, currency)})]),
      el('span', {class: 'money-owner-track', 'aria-hidden': 'true'}, el('span', {class: 'money-owner-fill', style: {width: `${workspace.total / max * 100}%`}})),
      el('span', {class: 'money-owner-workspace-meta', text: `${workspace.label} · ${shareLabel(workspace.share)} of spending · ${workspace.count} purchase${workspace.count === 1 ? '' : 's'}`}),
    ], {class: 'money-owner-workspace', ...props(workspace), disabled: !workspace.known,
      'aria-label': `${workspace.name}, ${workspace.label}: ${cash(workspace.total, currency)}, ${shareLabel(workspace.share)} of spending${workspace.known ? '. View workspace.' : ''}`,
      onClick: () => onEntity(workspace.id)}))),
    !summary.workspaces.length && muted('No activity recorded in this period.'),
  ]);
}
