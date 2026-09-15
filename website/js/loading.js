/** The app's wing opening, as a brief, optional website introduction.
 * The page never depends on this module: no content is hidden or made inert.
 * Native popover dismissal and a CSS deadline remain usable if other JS fails. */

function element(document, tag, attributes = {}, children = []) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (name === 'text') node.textContent = value;
    else node.setAttribute(name, value);
  }
  for (const child of children) node.appendChild(child);
  return node;
}

/** Paired wings retain the app's shared, slightly varied flight trajectory. */
export function animateWebsiteWings(screen, { document, window }) {
  const wings = [...screen.querySelectorAll('.site-wing-motion')];
  if (wings.length !== 2 || wings.some(wing => typeof wing.animate !== 'function')) return () => {};
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const random = (low, high) => low + Math.random() * (high - low);
  const pose = angle => `rotate(${angle}deg) scaleX(${angle > 0 ? 1 - angle * .012 : 1 - angle * .002})`;
  let animations = [], revision = 0, folded = 0, disposed = false;
  const hold = angle => wings.forEach(wing => { wing.style.transform = pose(angle); });
  function stop() {
    revision++;
    animations.forEach(animation => animation.cancel());
    animations = []; folded = 0; hold(0);
  }
  function beat() {
    if (disposed || motion.matches || document.hidden || animations.length) return;
    const mine = ++revision;
    const open = random(-8.5, -4.5), close = random(1.8, 4.5);
    const apex = random(.37, .49), glide = Math.random() < .22 ? random(.08, .17) : 0;
    const easing = 'cubic-bezier(.45,0,.55,1)';
    const frames = [{ transform: pose(folded), offset: 0, easing }, { transform: pose(open), offset: apex, easing }];
    if (glide) frames.push({ transform: pose(open), offset: apex + glide, easing });
    frames.push({ transform: pose(close), offset: 1 });
    const timing = { duration: random(2400, 3800) + glide * 4000, easing: 'linear', fill: 'forwards' };
    try { for (const wing of wings) animations.push(wing.animate(frames, timing)); }
    catch { stop(); return; }
    Promise.all(animations.map(animation => animation.finished)).then(() => {
      if (disposed || mine !== revision) return;
      folded = close; hold(close);
      animations.forEach(animation => animation.cancel()); animations = [];
      beat();
    }).catch(() => { /* Skip, reduced motion and a hidden tab cancel a beat. */ });
  }
  function update() {
    screen.toggleAttribute('data-paused', document.hidden);
    if (motion.matches || document.hidden) stop(); else beat();
  }
  motion.addEventListener('change', update);
  document.addEventListener('visibilitychange', update);
  update();
  return () => {
    disposed = true; stop();
    motion.removeEventListener('change', update);
    document.removeEventListener('visibilitychange', update);
  };
}

export function createWebsiteLaunch({ document = globalThis.document, window = globalThis.window, duration = 3000 } = {}) {
  const screen = element(document, 'div', {
    id: 'zelos-site-launch', class: 'site-launch', popover: 'auto', role: 'dialog',
    'aria-labelledby': 'zelos-site-launch-title',
  });
  // Older browsers keep the website and its normal navigation without an intro.
  if (typeof screen.showPopover !== 'function' || typeof screen.hidePopover !== 'function') return null;
  const skip = element(document, 'button', {
    type: 'button', class: 'site-launch-skip', text: 'Skip opening',
    popovertarget: screen.id || 'zelos-site-launch', popovertargetaction: 'hide', autofocus: '',
  });
  const brand = element(document, 'div', { class: 'site-launch-brand', 'aria-hidden': 'true' }, [
    element(document, 'span', { class: 'site-launch-mark' }, ['left', 'right'].map(side =>
      element(document, 'span', { class: `site-launch-wing site-launch-wing--${side}` }, [
        element(document, 'span', { class: 'site-wing-motion' }, [1, 2, 3].map(number =>
          element(document, 'span', { class: `site-feather site-feather--${number}` }))),
      ]))),
    element(document, 'p', { class: 'site-launch-name' }, [...'ZELOS'].map(letter =>
      element(document, 'span', { class: 'site-launch-letter', text: letter }))),
  ]);
  screen.appendChild(brand);
  screen.appendChild(element(document, 'h2', { id: 'zelos-site-launch-title', class: 'screen-line', text: 'The Zelos opening' }));
  screen.appendChild(skip);
  let opened = false, disposed = false, timer = null, previousFocus = null, stopFlight = () => {};
  function finish() {
    if (!opened) return;
    opened = false;
    window.clearTimeout(timer); timer = null;
    stopFlight(); stopFlight = () => {};
    if (screen.contains(document.activeElement) || document.activeElement === document.body) {
      const target = previousFocus?.isConnected && previousFocus !== document.body
        ? previousFocus : document.querySelector('main');
      if (target) {
        const temporary = !target.hasAttribute('tabindex') && target.tagName === 'MAIN';
        if (temporary) target.setAttribute('tabindex', '-1');
        target.focus({ preventScroll: true });
        if (temporary) target.removeAttribute('tabindex');
      }
    }
    previousFocus = null;
  }
  function close() {
    if (!opened) return;
    try { screen.hidePopover(); } finally { finish(); }
  }
  function play() {
    if (disposed) return false;
    if (opened) { skip.focus({ preventScroll: true }); return true; }
    previousFocus = document.activeElement;
    opened = true;
    // Arm the independent exit before showing or attempting any animation.
    timer = window.setTimeout(close, Math.min(3000, Math.max(0, duration)));
    try {
      screen.showPopover();
      skip.focus({ preventScroll: true });
      stopFlight = animateWebsiteWings(screen, { document, window });
    } catch {
      close();
      return false;
    }
    return true;
  }
  const onToggle = event => { if (event.newState === 'closed') finish(); };
  const onKey = event => {
    if (event.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    else if (event.key === 'Tab') close(); // Continue into the page's normal tab order.
  };
  screen.addEventListener('toggle', onToggle);
  screen.addEventListener('keydown', onKey);
  skip.addEventListener('click', close);
  document.body.appendChild(screen);
  return { screen, play, close, get isOpen() { return opened; }, destroy() {
    close(); disposed = true;
    screen.removeEventListener('toggle', onToggle);
    screen.removeEventListener('keydown', onKey);
    skip.removeEventListener('click', close);
    screen.remove();
  } };
}

export function initWebsiteLaunch({ document = globalThis.document, window = globalThis.window } = {}) {
  const launch = createWebsiteLaunch({ document, window });
  if (!launch) return null;
  document.querySelectorAll('[data-replay-launch]').forEach(control => {
    control.hidden = false;
    control.addEventListener('click', event => { event.preventDefault(); launch.play(); });
  });
  let seen = false;
  try { seen = window.sessionStorage.getItem('zelos.site-opening') === 'seen'; }
  catch { /* A blocked storage API must not break the page. */ }
  if (!seen && !window.location.hash && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    try { window.sessionStorage.setItem('zelos.site-opening', 'seen'); } catch {}
    launch.play();
  }
  return launch;
}

if (typeof document !== 'undefined') {
  const boot = () => { try { initWebsiteLaunch(); } catch { /* The website remains fully usable. */ } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
}
