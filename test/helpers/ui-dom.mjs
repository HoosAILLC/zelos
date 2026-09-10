/** Small DOM fixture for interaction tests. It models focus and modal state,
 * not layout; native appearance and screen-reader checks still need the app. */
export class TestNode {
  constructor(tag, doc) {
    this.tag = tag; this.tagName = tag.toUpperCase(); this.ownerDocument = doc;
    this.attributes = {}; this.children = []; this.listeners = new Map();
    this.dataset = {}; this.value = ''; this.textContent = ''; this.disabled = false;
    this.style = { setProperty() {} }; this.parentNode = null; this.open = false;
    this.classList = { add() {}, remove() {}, toggle() {} };
  }
  get isConnected() { return this === this.ownerDocument.body || Boolean(this.parentNode?.isConnected); }
  get hidden() { return this.attributes.hidden !== undefined; }
  set hidden(want) { if (want) this.attributes.hidden = ''; else delete this.attributes.hidden; }
  get firstChild() { return this.children[0] || null; }
  setAttribute(key, value) { this.attributes[key] = String(value); if (key === 'value') this.value = String(value); }
  getAttribute(key) { return this.attributes[key] ?? null; }
  removeAttribute(key) { delete this.attributes[key]; }
  toggleAttribute(key, force) { const want = force === undefined ? !(key in this.attributes) : force; if (want) this.attributes[key] = ''; else delete this.attributes[key]; return Boolean(want); }
  addEventListener(type, fn) { this.listeners.set(type, [...(this.listeners.get(type) || []), fn]); }
  removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== fn)); }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  prepend(child) { child.parentNode = this; this.children.unshift(child); }
  replaceChildren(...children) { this.children.forEach(child => { child.parentNode = null; }); this.children = []; children.forEach(child => this.appendChild(child)); }
  replaceWith(other) { if (!this.parentNode) return; const parent = this.parentNode; parent.children[parent.children.indexOf(this)] = other; other.parentNode = parent; this.parentNode = null; }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; }
  focus() { this.ownerDocument.activeElement = this; }
  scrollIntoView() { this.scrolled = true; }
  showModal() { this.open = true; this.modal = true; }
  close() { this.open = false; this.fire('close'); }
  contains(other) { return walk(this).includes(other); }
  querySelectorAll(selector) { return walk(this).slice(1).filter(node => selector.split(',').some(part => matches(node, part.trim()))); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { for (let node = this; node; node = node.parentNode) if (matches(node, selector)) return node; return null; }
  fire(type, props = {}) {
    const event = { type, target: this, currentTarget: this, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...props };
    for (let node = this; node; node = node.parentNode) {
      event.currentTarget = node;
      for (const fn of node.listeners.get(type) || []) fn.call(node, event);
      if (event.stopped || type === 'close') break;
    }
    return event;
  }
  click() { if (!this.disabled) this.fire('click'); }
}
function matches(node, selector) {
  if (selector.startsWith('.')) return (node.attributes.class || '').split(/\s+/).includes(selector.slice(1));
  const attr = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector);
  if (attr) return attr[2] === undefined ? attr[1] in node.attributes : node.attributes[attr[1]] === attr[2];
  return node.tag === selector;
}
export function walk(node) { return [node, ...node.children.flatMap(walk)]; }
export function text(node) { return walk(node).map(item => item.textContent).filter(Boolean).join(' '); }
export function findButton(node, label) { return walk(node).find(item => item.tag === 'button' && text(item) === label); }
export function installDom(t) {
  const keys = ['document', 'window', 'Node', 'sessionStorage', 'localStorage', 'requestAnimationFrame'];
  const previous = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  const document = { activeElement: null, visibilityState: 'visible', listeners: new Map(),
    documentElement: { style: { setProperty() {} } },
    createElement(tag) { return new TestNode(tag, document); },
    createTextNode(value) { const node = new TestNode('#text', document); node.textContent = String(value); return node; },
    addEventListener(type, fn) { this.listeners.set(type, [...(this.listeners.get(type) || []), fn]); },
    removeEventListener() {},
  };
  document.body = document.createElement('body');
  const values = { document, Node: TestNode,
    window: { location: { href: 'http://127.0.0.1:7777/', hash: '#/now' }, history: { replaceState() {} }, addEventListener() {} },
    sessionStorage: { getItem() { return ''; }, setItem() {}, removeItem() {} },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    requestAnimationFrame: fn => { fn(); return 0; },
  };
  keys.forEach(key => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: values[key] }));
  t.after(() => keys.forEach((key, index) => { if (previous[index]) Object.defineProperty(globalThis, key, previous[index]); else delete globalThis[key]; }));
  return document;
}
export const settle = async () => { await new Promise(resolve => setImmediate(resolve)); };
