/** Shared campaign motion. No framework, scroll interception, or hidden content. */
(() => {
const root = document.documentElement;
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const fine = matchMedia('(hover: hover) and (pointer: fine)');
const phone = matchMedia('(max-width: 760px)');
const ease = 'cubic-bezier(.2,.75,.2,1)';
const activeAnimations = new Set();
let preference = '';
try { preference = sessionStorage.getItem('zelos.site-motion') || ''; } catch {}
let enabled = !reduced.matches && preference !== 'paused';
let pageVisible = !document.hidden;
let frame = 0;
let videoVisible = false;
let heroStarted = false;
let flowTimer = 0;
let flowVisible = false;
let flowStep = -1;

function animate(element, frames, timing = {}) {
  if (!enabled || !pageVisible || !element?.animate) return;
  const animation = element.animate(frames, {duration: 850, easing: ease, fill: 'backwards', ...timing});
  activeAnimations.add(animation);
  animation.finished.catch(() => {}).finally(() => activeAnimations.delete(animation));
  return animation;
}

const control = document.createElement('button');
control.type = 'button';
control.className = 'motion-control';
document.body.append(control);
const progress = document.createElement('div');
progress.className = 'reading-progress';
progress.setAttribute('aria-hidden','true');
document.body.append(progress);

const preview = document.querySelector('.hero-film-preview');
const video = document.querySelector('.hero-ambient');
const stone = document.querySelector('.ownership>img');
const cta = document.querySelector('.page-cta');
const flow = document.querySelector('.context-flow');
const steps = flow ? [...flow.querySelectorAll(':scope>span')] : [];

function syncVideo() {
  if (!video) return;
  if (!enabled || !pageVisible || !videoVisible || !heroStarted) { video.pause(); return; }
  // Keep the poster when bandwidth saving is enabled, unless motion was requested.
  if (navigator.connection?.saveData && preference !== 'full') return;
  if (!video.getAttribute('src')) video.src = phone.matches ? video.dataset.mobile : video.dataset.desktop;
  video.muted = true;
  video.play().catch(() => { preview.removeAttribute('data-playing'); });
}
video?.addEventListener('playing', () => {
  if (enabled && pageVisible && videoVisible) preview.setAttribute('data-playing','');
  else video.pause();
});
video?.addEventListener('error', () => preview.removeAttribute('data-playing'));

function renderScroll() {
  frame = 0;
  if (!pageVisible) return;
  const max = Math.max(1, root.scrollHeight - innerHeight);
  progress.style.transform = `scaleX(${Math.min(1,Math.max(0,scrollY / max))})`;
  if (!enabled || !fine.matches) return;
  if (preview) {
    const rect = preview.getBoundingClientRect();
    if (rect.bottom > 0 && rect.top < innerHeight) {
      preview.style.setProperty('--scene-y', `${Math.max(-22,Math.min(22,(innerHeight*.42-rect.top)*.045))}px`);
    }
  }
  if (stone) {
    const rect = stone.parentElement.getBoundingClientRect();
    if (rect.bottom > 0 && rect.top < innerHeight) stone.style.setProperty('--stone-y',`${Math.max(-18,Math.min(18,(innerHeight*.35-rect.top)*.045))}px`);
  }
}
function scheduleScroll() { if (!frame && pageVisible) frame = requestAnimationFrame(renderScroll); }
addEventListener('scroll',scheduleScroll,{passive:true});
addEventListener('resize',scheduleScroll,{passive:true});

function syncPreference() {
  root.dataset.motion = enabled ? 'on' : 'off';
  root.toggleAttribute('data-page-hidden', !pageVisible);
  control.textContent = enabled ? 'Pause motion' : 'Enable motion';
  control.setAttribute('aria-label', enabled ? 'Pause website motion' : 'Enable website motion');
  const replay = document.querySelector('.flow-replay');
  if (replay) {
    replay.disabled = !enabled;
    replay.textContent = enabled ? 'Replay the flow ↻' : 'Flow animation paused';
  }
  if (!enabled || !pageVisible) {
    activeAnimations.forEach(animation => animation.cancel());
    activeAnimations.clear();
    clearTimeout(flowTimer);
    if (!enabled) steps.forEach(step => step.classList.remove('is-active'));
  }
  syncVideo();
  scheduleScroll();
  if (enabled && pageVisible && flowVisible && flowStep < steps.length) advanceFlow();
}
control.addEventListener('click', () => {
  enabled = !enabled;
  preference = enabled ? 'full' : 'paused';
  try { sessionStorage.setItem('zelos.site-motion',preference); } catch {}
  syncPreference();
});
reduced.addEventListener('change', () => { enabled = !reduced.matches && preference !== 'paused'; syncPreference(); });
document.addEventListener('visibilitychange', () => { pageVisible = !document.hidden; syncPreference(); });

function enterHero() {
  if (heroStarted) return;
  heroStarted = true;
  const lines = document.querySelectorAll('.hero-title-line>span');
  lines.forEach((line,index) => animate(line,[{transform:'translateY(110%)',opacity:.2},{transform:'translateY(0)',opacity:1}],{duration:1100,delay:index*140}));
  [document.querySelector('.hero-heading>.eyebrow'),document.querySelector('.hero-bottom')].forEach((element,index) => animate(element,[{opacity:0,transform:'translateY(20px)'},{opacity:1,transform:'translateY(0)'}],{delay:160+index*130}));
  animate(document.querySelector('.hero-film'),[{opacity:.2,transform:'translateY(30px) scale(.97)'},{opacity:1,transform:'translateY(0) scale(1)'}],{duration:1300,delay:250});
  syncVideo();
}
function afterOpening() {
  const opening = document.querySelector('#zelos-site-launch');
  if (opening?.matches(':popover-open')) {
    opening.addEventListener('toggle', event => { if (event.newState === 'closed') enterHero(); });
  } else enterHero();
}
if (document.readyState === 'complete') requestAnimationFrame(afterOpening);
else addEventListener('load',afterOpening,{once:true});

const cardSelector = '.new-grid>article,.home-path-grid>a,.feature-groups>article,.value-grid>article,.example-grid>article,.ai-options>article,.download-options>article,.vision-journey>li';
const cards = [...document.querySelectorAll(cardSelector)];
cards.forEach(card => {
  card.classList.add('motion-card');
  let tilt;
  card.addEventListener('pointermove', event => {
    if (!enabled || !fine.matches || event.pointerType === 'touch') return;
    const bounds = card.getBoundingClientRect();
    const x = (event.clientX-bounds.left)/bounds.width;
    const y = (event.clientY-bounds.top)/bounds.height;
    card.style.setProperty('--light-x',`${x*100}%`);
    card.style.setProperty('--light-y',`${y*100}%`);
    // Small rotations retain stable click targets and do not affect layout.
    const current = getComputedStyle(card).transform;
    tilt?.cancel();
    tilt = animate(card,[{transform:current},{transform:`perspective(1000px) rotateX(${(0.5-y)*3}deg) rotateY(${(x-.5)*3}deg) translateY(-4px)`}],{duration:250,fill:'forwards'});
  });
  card.addEventListener('pointerleave', () => {
    const transform = getComputedStyle(card).transform;
    tilt?.cancel();
    animate(card,[{transform},{transform:'none'}],{duration:450});
  });
});

if ('IntersectionObserver' in window) {
  const reveal = new IntersectionObserver(entries => {
    let order = 0;
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      reveal.unobserve(entry.target);
      // The iframe only moves during its initial entrance, never while in use.
      const isDemo = entry.target.classList.contains('live-demo');
      animate(entry.target,[{opacity:0,transform:isDemo?'perspective(1400px) rotateX(3deg) translateY(25px)':'translateY(28px)'},{opacity:1,transform:'none'}],{duration:isDemo?1100:800,delay:Math.min(order++,3)*90});
    }
  },{threshold:.08,rootMargin:'0px 0px -30px 0px'});
  document.querySelectorAll(`${cardSelector},.section-heading,.page-intro,.live-demo,.ownership-copy,.how-steps>li,.connection-rows>div,.vision-glasses,.vision-foundation,.film-heading,.film-player,.page-cta>div`).forEach(element => reveal.observe(element));
  const visible = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.target === preview) { videoVisible = entry.isIntersecting; syncVideo(); }
      if (entry.target === cta) cta.classList.toggle('motion-in-view',entry.isIntersecting);
      if (entry.target === flow) {
        flowVisible = entry.isIntersecting;
        if (flowVisible && flowStep < steps.length) advanceFlow();
        else clearTimeout(flowTimer);
      }
    }
  },{threshold:.1});
  [preview,cta,flow].filter(Boolean).forEach(element => visible.observe(element));
} else { videoVisible = true; }

// A reveal must never obscure the element someone has tabbed to or linked to.
document.addEventListener('focusin',event => {
  activeAnimations.forEach(animation => {
    if (animation.effect?.target?.contains(event.target)) animation.finish();
  });
});

function advanceFlow() {
  clearTimeout(flowTimer);
  if (!steps.length || !enabled || !pageVisible || !flowVisible || flowStep >= steps.length) return;
  flowStep++;
  steps.forEach((step,index) => step.classList.toggle('is-active',index === Math.min(flowStep,steps.length-1)));
  if (flowStep < steps.length-1) flowTimer = setTimeout(advanceFlow,1500);
  else flowStep = steps.length;
}
if (steps.length) {
  flow.classList.add('motion-flow');
  steps.forEach((step,index) => { step.dataset.step = `0${index+1}`; });
  const replay = document.createElement('button');
  replay.type = 'button'; replay.className = 'flow-replay'; replay.textContent = 'Replay the flow ↻';
  flow.after(replay);
  replay.addEventListener('click', () => {
    flowStep = -1;
    if (enabled) advanceFlow();
    else steps.forEach(step => step.classList.remove('is-active'));
  });
}

const routeList = document.querySelector('.demo-routes');
if (routeList) {
  const indicator = document.createElement('span');
  indicator.className = 'demo-route-indicator'; indicator.setAttribute('aria-hidden','true');
  routeList.prepend(indicator); routeList.classList.add('has-indicator');
  const position = () => {
    const selected = routeList.querySelector('[aria-pressed="true"]');
    indicator.hidden = !selected;
    if (!selected) return;
    indicator.style.width = `${selected.offsetWidth}px`;
    indicator.style.height = `${selected.offsetHeight}px`;
    indicator.style.transform = `translate(${selected.offsetLeft}px,${selected.offsetTop}px)`;
  };
  new MutationObserver(position).observe(routeList,{subtree:true,attributes:true,attributeFilter:['aria-pressed']});
  if ('ResizeObserver' in window) new ResizeObserver(position).observe(routeList);
  document.fonts?.ready.then(position);
  position();
  let highlightTimer;
  routeList.addEventListener('click',event => {
    if (!event.target.closest('button')) return;
    const demo = document.querySelector('.live-demo');
    demo?.classList.add('demo-changed'); clearTimeout(highlightTimer);
    highlightTimer = setTimeout(() => demo?.classList.remove('demo-changed'),650);
  });
}
document.querySelectorAll('details').forEach(details => details.addEventListener('toggle', () => {
  if (details.open) animate(details.querySelector(':scope>div'),[{opacity:0,transform:'translateY(-7px)'},{opacity:1,transform:'none'}],{duration:350});
}));
syncPreference();
})();
