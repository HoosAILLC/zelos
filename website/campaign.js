'use strict';
document.documentElement.classList.add('js-ready');

// Old one-page bookmarks keep working; fragments never reach the host.
function redirectLegacySection() {
  if (location.pathname !== '/' && location.pathname !== '/index.html') return;
  const hash = location.hash.slice(1);
  const legacy = {
    see:'/features#see', walkthrough:'/features#see', does:'/features#does',
    why:'/features#how', how:'/features#how', models:'/features#models',
    sources:'/features#sources', ai:'/features#models', control:'/features#models',
    vision:'/vision#vision', 'smart-glasses':'/vision#smart-glasses',
    download:'/download', limits:'/download#limits', safe:'/download#safe',
  };
  const target = hash.startsWith('feature-') ? '/features#' + encodeURIComponent(hash) : legacy[hash];
  if (target) location.replace(target);
}
redirectLegacySection();
window.addEventListener('hashchange',redirectLegacySection);

const menu = document.querySelector('.menu');
const navigation = document.querySelector('#navigation');
const desktop = window.matchMedia('(min-width: 761px)');

function setMenu(open) {
  menu?.setAttribute('aria-expanded', String(open));
  menu?.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
  if (menu) menu.textContent = open ? 'Close' : 'Menu';
  navigation?.classList.toggle('is-open', open);
}
function closeMenu() { setMenu(false); }
closeMenu();
menu?.addEventListener('click', () => setMenu(menu.getAttribute('aria-expanded') !== 'true'));
navigation?.addEventListener('click', event => {
  if (event.target.closest('a')) closeMenu();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && menu?.getAttribute('aria-expanded') === 'true') {
    closeMenu();
    menu.focus();
  }
});
document.addEventListener('pointerdown', event => {
  if (menu?.getAttribute('aria-expanded') === 'true' && !event.target.closest('.site-header')) closeMenu();
});

const demo = document.querySelector('#zelos-demo');
const routes = new Set(['now','today','owed','mail','calendar','search','ask','progress','finance','family','health','jobs','documents','booking','shopping','settings']);
const requested = new URLSearchParams(location.search).get('demo');
let pendingRoute = routes.has(requested) ? requested : 'now';
const controls = [...document.querySelectorAll('[data-demo-route]')];
const mobileLaunch = document.querySelector('[data-mobile-demo-link]');

function markRoute(route) {
  document.querySelectorAll('.demo-routes button').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.demoRoute === route));
  });
  if (mobileLaunch) mobileLaunch.href = '/try/#/' + route;
}
function mountDemo() {
  // A phone loads the full-screen demo only after its visitor opens it.
  if (!desktop.matches || !demo || demo.getAttribute('src')) return;
  const source = demo.dataset.src;
  if (source) demo.src = source.split('#')[0] + '#/' + pendingRoute;
}
function selectRoute(route) {
  if (!routes.has(route)) return;
  pendingRoute = route;
  markRoute(route);
  if (!desktop.matches || !demo) return;
  mountDemo();
  if (demo.getAttribute('src')) demo.contentWindow?.postMessage({type:'zelos-demo-route', route}, location.origin);
}
function syncLayout() {
  closeMenu();
  controls.forEach(control => {
    const route = control.dataset.demoRoute;
    if (!routes.has(route) || control.tagName !== 'A') return;
    control.href = desktop.matches ? '/features?demo=' + route + '#see' : '/try/#/' + route;
  });
  markRoute(pendingRoute);
  mountDemo();
}
controls.forEach(control => {
  const route = control.dataset.demoRoute;
  if (!routes.has(route)) return;
  control.addEventListener('click', event => {
    if (!desktop.matches || !demo) return;
    // Modified clicks retain ordinary link behavior, including the route.
    if (control.tagName === 'A' && (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) return;
    event.preventDefault();
    selectRoute(route);
    if (control.tagName === 'A') {
      const motion = window.matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.dataset?.motion === 'off' ? 'auto' : 'smooth';
      document.getElementById('see')?.scrollIntoView({behavior: motion, block: 'start'});
    }
  });
});
if (demo) {
  demo.addEventListener('load', () => selectRoute(pendingRoute));
  window.addEventListener('message', event => {
    if (event.origin !== location.origin || event.source !== demo.contentWindow || event.data?.type !== 'zelos-demo-ready' || !routes.has(event.data.route)) return;
    pendingRoute = event.data.route;
    markRoute(pendingRoute);
  });
}
desktop.addEventListener('change', syncLayout);
syncLayout();
