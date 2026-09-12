'use strict';
document.documentElement.classList.add('js-ready');
const menu=document.querySelector('.menu'),navigation=document.querySelector('#navigation');
function closeMenu(){menu.setAttribute('aria-expanded','false');navigation.classList.remove('is-open');}
menu.addEventListener('click',()=>{const open=menu.getAttribute('aria-expanded')!=='true';menu.setAttribute('aria-expanded',String(open));navigation.classList.toggle('is-open',open);});
navigation.addEventListener('click',event=>{if(event.target.closest('a'))closeMenu();});
document.addEventListener('keydown',event=>{if(event.key==='Escape')closeMenu();});
const demo=document.querySelector('#zelos-demo');let pendingRoute='now';
function markRoute(route){document.querySelectorAll('.demo-routes button').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.demoRoute===route)));}
function selectRoute(route){pendingRoute=route;demo.contentWindow?.postMessage({type:'zelos-demo-route',route},location.origin);markRoute(route);}
document.querySelectorAll('[data-demo-route]').forEach(control=>control.addEventListener('click',()=>selectRoute(control.dataset.demoRoute)));
demo.addEventListener('load',()=>selectRoute(pendingRoute));
window.addEventListener('message',event=>{if(event.origin!==location.origin||event.source!==demo.contentWindow||event.data?.type!=='zelos-demo-ready')return;markRoute(event.data.route);});
