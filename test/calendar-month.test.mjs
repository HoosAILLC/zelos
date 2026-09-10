import test from 'node:test';
import assert from 'node:assert/strict';

// A small DOM for rendering the actual month view and clicking its controls.
class TestNode {
  constructor(tagName = '') {
    this.tagName = tagName;
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.dataset = {};
    this.style = { setProperty() {} };
    this.hidden = false;
    this.isConnected = false;
  }
  setAttribute(name, value) {
    this.attributes.set(name, value);
    if (name === 'hidden') this.hidden = true;
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  click() { this.listeners.get('click')?.call(this, { target: this }); }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  after(node) {
    node.parentNode = this.parentNode;
    const siblings = this.parentNode.children;
    siblings.splice(siblings.indexOf(this) + 1, 0, node);
  }
  set textContent(value) {
    this.children = [];
    this.text = String(value);
  }
  get textContent() {
    return (this.text ?? '') + this.children.map((child) => child.textContent).join('');
  }
}

globalThis.Node = TestNode;
globalThis.document = {
  createElement: (tag) => new TestNode(tag),
  createTextNode(text) {
    const node = new TestNode();
    node.textContent = text;
    return node;
  },
};
globalThis.window = {
  location: { href: 'http://localhost/' },
  matchMedia: () => ({ matches: true }),
};
globalThis.requestAnimationFrame = () => 0;

const { state } = await import('../ui/lib/store.js');
const { renderCalendar } = await import('../ui/views/calendar.js');

function nodes(root, predicate) {
  return [root, ...root.children.flatMap((child) => nodes(child, () => true))].filter(predicate);
}
function hasClass(node, name) { return (node.getAttribute('class') ?? '').split(/\s+/).includes(name); }
function byClass(root, name) { return nodes(root, (node) => hasClass(node, name)); }
function titles(root) { return byClass(root, 'month-ev-title').map((node) => node.textContent); }

const DATE = '2026-09-10';
function event(title, start, end) {
  return { id: title, title, starts_at: `${DATE}T${start}:00-04:00`, ends_at: `${DATE}T${end}:00-04:00`, all_day: false };
}
function renderMonth(events) {
  state.config = { calendars: [{ id: 'test-calendar' }] };
  state.board = {
    ...state.board,
    events,
    now: `${DATE}T09:00:00-04:00`,
    eventWindow: { from: '2026-09-01', to: '2026-09-30' },
  };
  state.boardAt = Date.now();
  let root;
  const rerender = () => { root = renderCalendar({ sub: DATE, rerender }); };
  rerender();
  nodes(root, (node) => node.tagName === 'button' && node.textContent === 'Month')[0].click();
  return byClass(root, 'month-cell').find((cell) => titles(cell).length);
}

test('month cells show morning events before later conflicts, retaining conflict marks', () => {
  const cell = renderMonth([
    event('Shop-drawing review', '14:00', '15:00'),
    event('Timber delivery', '14:30', '15:30'),
    event('Morning meeting', '09:30', '10:00'),
  ]);

  assert.deepEqual(titles(cell), ['Morning meeting', 'Shop-drawing review', 'Timber delivery']);
  assert.deepEqual(byClass(cell, 'is-conflict').flatMap(titles), ['Shop-drawing review', 'Timber delivery']);
  assert.equal(byClass(cell, 'month-flag')[0].textContent, 'clash');
});

test('month overflow continues chronological order after all-day entries and still signals hidden clashes', () => {
  const cell = renderMonth([
    event('Timber delivery', '14:30', '15:30'),
    event('Second meeting', '09:30', '10:00'),
    { id: 'all-day', title: 'All-day reminder', starts_at: DATE, ends_at: '2026-09-11', all_day: true },
    event('Shop-drawing review', '14:00', '15:00'),
    event('First meeting', '08:00', '09:00'),
  ]);
  const lists = byClass(cell, 'month-list');

  assert.deepEqual(titles(lists[0]), ['All-day reminder', 'First meeting', 'Second meeting']);
  assert.deepEqual(titles(lists[1]), ['Shop-drawing review', 'Timber delivery']);
  assert.equal(lists[1].hidden, true);
  assert.equal(byClass(cell, 'month-flag')[0].textContent, 'clash');
  const more = byClass(cell, 'month-more')[0];
  assert.equal(more.textContent, '+2 more');
  more.click();
  assert.equal(lists[1].hidden, false);
  assert.equal(more.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(titles(cell), ['All-day reminder', 'First meeting', 'Second meeting', 'Shop-drawing review', 'Timber delivery']);
});
