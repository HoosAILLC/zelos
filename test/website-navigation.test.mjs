import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const script = fs.readFileSync(new URL('../website/campaign.js', import.meta.url), 'utf8');
function page(pathname = '/', hash = '') {
  const events = new Map(), redirects = [];
  const location = {pathname, hash, search:'', replace: target => redirects.push(target)};
  const document = {
    documentElement:{classList:{add(){}}},
    querySelector:()=>null, querySelectorAll:()=>[], addEventListener(){},
  };
  const window = {addEventListener:(name,handler)=>events.set(name,handler), matchMedia:()=>({addEventListener(){}})};
  vm.runInNewContext(script,{document,window,location,URLSearchParams});
  return {location,redirects,changeHash(hash){location.hash=hash;events.get('hashchange')();}};
}

test('old bookmarks reach the new pages on first load',()=>{
  assert.deepEqual(page('/','#download').redirects,['/download']);
  assert.deepEqual(page('/index.html','#smart-glasses').redirects,['/vision#smart-glasses']);
  assert.deepEqual(page('/','#feature-groceries').redirects,['/features#feature-groceries']);
});

test('old bookmarks also work when the homepage is already open',()=>{
  const home=page();
  home.changeHash('#see');
  home.changeHash('#safe');
  assert.deepEqual(home.redirects,['/features#see','/download#safe']);
});

test('current homepage anchors and anchors on other pages stay in place',()=>{
  for(const hash of ['#new','#privacy','#main','#unknown']) assert.deepEqual(page('/',hash).redirects,[]);
  const features=page('/features','#see');
  features.changeHash('#feature-groceries');
  assert.deepEqual(features.redirects,[]);
});

// Small event/element surfaces are enough to exercise the shipped page script.
// No browser globals are changed, so these cases can run with the other tests.
function responsivePage({width = 390, search = '', embedded = true} = {}) {
  function events() {
    const listeners = new Map();
    return {
      addEventListener(name, handler) {
        if (!listeners.has(name)) listeners.set(name, []);
        listeners.get(name).push(handler);
      },
      fire(name, event = {}) { for (const handler of listeners.get(name) || []) handler(event); },
    };
  }
  function element(tagName, dataset = {}) {
    const attributes = new Map(), classes = new Set();
    return {
      ...events(), tagName, dataset, href: '', textContent: '',
      getAttribute: name => attributes.get(name) ?? null,
      setAttribute: (name, value) => attributes.set(name, String(value)),
      classList: {
        add: name => classes.add(name),
        contains: name => classes.has(name),
        toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name),
      },
      focus() { document.activeElement = this; },
      click(extra = {}) {
        const event = {target: this, defaultPrevented: false,
          preventDefault() { this.defaultPrevented = true; }, ...extra};
        this.fire('click', event);
        return event;
      },
    };
  }
  const menu = element('BUTTON'), navigation = element('NAV');
  const iframe = element('IFRAME', {src: '/try/#/now'}), mobileLink = element('A');
  const featureLink = element('A', {demoRoute: 'health'});
  const routeButtons = ['now', 'finance', 'health', 'ask'].map(route => element('BUTTON', {demoRoute: route}));
  const messages = [], loads = [], scrolls = [], media = new Map();
  iframe.contentWindow = {postMessage(message, origin) {
    messages.push({type: message.type, route: message.route, origin});
  }};
  Object.defineProperty(iframe, 'src', {
    get: () => iframe.getAttribute('src'),
    set(value) { iframe.setAttribute('src', value); loads.push(value); },
  });
  const document = {
    ...events(), activeElement: null, documentElement: element('HTML'),
    querySelector(selector) {
      return {'.menu': menu, '#navigation': navigation,
        '#zelos-demo': embedded ? iframe : null, '[data-mobile-demo-link]': mobileLink}[selector] ?? null;
    },
    querySelectorAll(selector) {
      if (selector === '[data-demo-route]') return [featureLink, ...routeButtons];
      if (selector === '.demo-routes button') return routeButtons;
      return [];
    },
    getElementById: () => ({scrollIntoView: options => scrolls.push(options.behavior)}),
  };
  function matches(query) {
    if (query === '(prefers-reduced-motion: reduce)') return false;
    const minimum = /^\(min-width:\s*(\d+)px\)$/.exec(query);
    assert.ok(minimum, `Unhandled media query: ${query}`);
    return width >= Number(minimum[1]);
  }
  const window = {...events(), matchMedia(query) {
    if (!media.has(query)) media.set(query, {...events(), matches: matches(query)});
    return media.get(query);
  }};
  const location = {pathname: '/features', hash: '#see', search, origin: 'https://zelos-app.netlify.app'};
  vm.runInNewContext(script, {document, window, location, URLSearchParams});
  return {
    menu, navigation, iframe, mobileLink, featureLink, routeButtons, messages, loads, scrolls, document,
    resize(nextWidth) {
      width = nextWidth;
      for (const [query, item] of media) {
        const next = matches(query);
        if (item.matches !== next) { item.matches = next; item.fire('change', {matches: next}); }
      }
    },
    message(data, extra = {}) {
      window.fire('message', {origin: location.origin, source: iframe.contentWindow, data, ...extra});
    },
  };
}

test('phones leave the embedded app unloaded and open feature links in the full-screen demo', () => {
  for (const width of [320, 390, 760]) {
    const f = responsivePage({width, search: '?demo=finance'});
    assert.equal(f.iframe.getAttribute('src'), null);
    assert.deepEqual(f.loads, []);
    assert.equal(f.mobileLink.href, '/try/#/finance');
    assert.equal(f.featureLink.href, '/try/#/health');
    assert.equal(f.featureLink.click().defaultPrevented, false, 'a phone follows the full-screen link normally');
    f.iframe.fire('load'); // The initial empty iframe document must not start the app either.
    assert.deepEqual(f.loads, []);
    assert.deepEqual(f.messages, []);
  }
});

test('desktop links load the requested demo route and keep modified clicks usable', () => {
  const f = responsivePage({width: 761, search: '?demo=finance'});
  assert.deepEqual(f.loads, ['/try/#/finance']);
  assert.equal(f.routeButtons.find(button => button.dataset.demoRoute === 'finance').getAttribute('aria-pressed'), 'true');
  f.iframe.fire('load');
  assert.deepEqual(f.messages.at(-1), {type: 'zelos-demo-route', route: 'finance', origin: 'https://zelos-app.netlify.app'});
  assert.equal(f.featureLink.href, '/features?demo=health#see');
  assert.equal(f.featureLink.click({ctrlKey: true}).defaultPrevented, false);
  assert.equal(f.featureLink.click({metaKey: true}).defaultPrevented, false);
  assert.equal(f.mobileLink.href, '/try/#/finance');
  assert.equal(f.featureLink.click().defaultPrevented, true);
  assert.equal(f.messages.at(-1).route, 'health');
  assert.deepEqual(f.scrolls, ['smooth']);
  assert.deepEqual(f.loads, ['/try/#/finance'], 'changing a route must not reload the demo');
});

test('resizing mounts the pending route once and preserves the active route for phone handoff', () => {
  const f = responsivePage({width: 390, search: '?demo=ask'});
  f.resize(760);
  assert.deepEqual(f.loads, []);
  f.resize(761);
  assert.deepEqual(f.loads, ['/try/#/ask']);
  f.message({type: 'zelos-demo-ready', route: 'health'});
  f.resize(390);
  assert.equal(f.mobileLink.href, '/try/#/health');
  assert.equal(f.featureLink.href, '/try/#/health');
  f.resize(1024);
  f.iframe.fire('load');
  assert.deepEqual(f.loads, ['/try/#/ask'], 'rotation must not discard the in-memory workspace');
  assert.equal(f.messages.at(-1).route, 'health');
});

test('invalid route parameters and malformed or foreign messages cannot change the selected route', () => {
  for (const search of ['?demo=unknown', '?demo=%2Fhealth', '?demo=%3Cscript%3E']) {
    assert.deepEqual(responsivePage({width: 1024, search}).loads, ['/try/#/now']);
  }
  const f = responsivePage({width: 1024, search: '?demo=finance'});
  for (const data of [null, undefined, 'health', 4, {}, {type: 'other', route: 'health'},
    {type: 'zelos-demo-ready'}, {type: 'zelos-demo-ready', route: ['health']},
    {type: 'zelos-demo-ready', route: 'https://elsewhere.invalid'}]) {
    assert.doesNotThrow(() => f.message(data));
  }
  f.message({type: 'zelos-demo-ready', route: 'health'}, {origin: 'https://elsewhere.invalid'});
  f.message({type: 'zelos-demo-ready', route: 'health'}, {source: {}});
  assert.equal(f.mobileLink.href, '/try/#/finance');
  assert.equal(f.routeButtons.find(button => button.dataset.demoRoute === 'finance').getAttribute('aria-pressed'), 'true');
  f.message({type: 'zelos-demo-ready', route: 'health'});
  assert.equal(f.mobileLink.href, '/try/#/health', 'only a valid message from this demo changes the selection');
});

test('Escape closes the mobile menu and restores keyboard focus to its control', () => {
  const f = responsivePage();
  f.menu.click();
  assert.equal(f.menu.getAttribute('aria-expanded'), 'true');
  assert.equal(f.navigation.classList.contains('is-open'), true);
  f.featureLink.focus();
  f.document.fire('keydown', {key: 'Escape'});
  assert.equal(f.menu.getAttribute('aria-expanded'), 'false');
  assert.equal(f.navigation.classList.contains('is-open'), false);
  assert.equal(f.document.activeElement, f.menu);
  f.menu.click();
  f.resize(1024);
  assert.equal(f.menu.getAttribute('aria-expanded'), 'false', 'desktop navigation must not retain a stale open-menu state');
});

test('pages without an embedded demo retain ordinary links to the selected desktop preview', () => {
  const f = responsivePage({width: 1024, embedded: false});
  assert.equal(f.featureLink.href, '/features?demo=health#see');
  assert.equal(f.featureLink.click().defaultPrevented, false);
  assert.deepEqual(f.loads, []);
});
