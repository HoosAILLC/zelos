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

const menu=document.querySelector('.menu'), navigation=document.querySelector('#navigation');
function closeMenu(){menu?.setAttribute('aria-expanded','false');navigation?.classList.remove('is-open');}
menu?.addEventListener('click',()=>{const open=menu.getAttribute('aria-expanded')!=='true';menu.setAttribute('aria-expanded',String(open));navigation?.classList.toggle('is-open',open);});
navigation?.addEventListener('click',event=>{if(event.target.closest('a'))closeMenu();});
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&menu?.getAttribute('aria-expanded')==='true'){closeMenu();menu.focus();}});
window.matchMedia('(min-width: 761px)').addEventListener('change',closeMenu);

const demo=document.querySelector('#zelos-demo');
const routes=new Set(['now','today','owed','mail','calendar','search','ask','progress','finance','family','health','jobs','documents','booking','shopping','settings']);
const requested=new URLSearchParams(location.search).get('demo');
let pendingRoute=routes.has(requested)?requested:'now';
function markRoute(route){document.querySelectorAll('.demo-routes button').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.demoRoute===route)));}
function selectRoute(route){if(!routes.has(route)||!demo)return;pendingRoute=route;demo.contentWindow?.postMessage({type:'zelos-demo-route',route},location.origin);markRoute(route);}
document.querySelectorAll('[data-demo-route]').forEach(control=>{
  const route=control.dataset.demoRoute;
  if(!routes.has(route))return;
  if(demo)control.addEventListener('click',()=>selectRoute(route));
  else if(control.tagName==='A')control.href='/features?demo='+encodeURIComponent(route)+'#see';
});
if(demo){
  demo.addEventListener('load',()=>selectRoute(pendingRoute));
  window.addEventListener('message',event=>{if(event.origin!==location.origin||event.source!==demo.contentWindow||event.data?.type!=='zelos-demo-ready'||!routes.has(event.data.route))return;markRoute(event.data.route);});
  markRoute(pendingRoute);
}

// Native players start only through user interaction and never overlap audio.
const films=[...document.querySelectorAll('video')];
films.forEach(video=>video.addEventListener('play',()=>{films.forEach(other=>{if(other!==video)other.pause();});}));
document.addEventListener('visibilitychange',()=>{if(document.hidden)films.forEach(video=>video.pause());});
