// Demo-only framing around the current Zelos interface.
import version from './lib/demo-version.js';
const bar=document.createElement('aside');bar.className='demo-notice';bar.setAttribute('aria-label','Demo information');
const label=document.createElement('div');
const strong=document.createElement('strong');strong.textContent=`Try Zelos ${version}`;
const text=document.createElement('span');text.textContent='Fictional data · example AI answers · changes reset on reload';
label.append(strong,text);
const reset=document.createElement('button');reset.type='button';reset.textContent='Reset demo';
reset.addEventListener('click',()=>{try{sessionStorage.removeItem('zelos.demo.ask.active');}catch{}location.reload();});
bar.append(label,reset);document.body.prepend(bar);
const measure=()=>document.documentElement.style.setProperty('--demo-notice-h',Math.ceil(bar.getBoundingClientRect().height)+'px');
measure();if(typeof ResizeObserver==='function')new ResizeObserver(measure).observe(bar);else window.addEventListener('resize',measure);
const allowed=new Set(['now','today','owed','mail','calendar','search','ask','progress','finance','family','health','jobs','documents','booking','shopping','settings']);
window.addEventListener('message',event=>{if(event.origin!==location.origin||event.source!==parent||event.data?.type!=='zelos-demo-route'||!allowed.has(event.data.route))return;location.hash='#/'+event.data.route;});
function tellParent(){if(parent!==window)parent.postMessage({type:'zelos-demo-ready',route:location.hash.replace('#/','').split('/')[0]||'now'},location.origin);}
window.addEventListener('hashchange',tellParent);tellParent();
// Credential/file controls never accept real input. The adapter independently
// rejects connections, uploads, sending, purchases and guest-access mutations.
function blockRealInputs(){for(const input of document.querySelectorAll('input[type="password"],input[type="file"]')){input.disabled=true;input.title='Available in the installed app. Use the sample records in this demo.';}}
blockRealInputs();new MutationObserver(blockRealInputs).observe(document.body,{childList:true,subtree:true});
