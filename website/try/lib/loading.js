import { el } from './dom.js';

/** One truthful status, with decorative placeholders that never enter the accessibility tree. */
export function loadingState(label = 'Loading…', { layout = 'rows' } = {}) {
  return el('div', { class: `zelos-loading zelos-loading--${layout}` }, [
    el('div', { class: 'zelos-loading-status', role: 'status' }, [
      el('span', { class: 'zelos-pulse', 'aria-hidden': 'true' }),
      el('span', { text: label }),
    ]),
    layout !== 'inline' && el('div', { class: `zelos-skeleton zelos-skeleton--${layout}`, 'aria-hidden': 'true' },
      Array.from({ length: 3 }, () => el('div', { class: 'zelos-skeleton-item' }, [
        el('span', { class: 'zelos-skeleton-line' }),
        el('span', { class: 'zelos-skeleton-line' }),
      ]))),
  ]);
}

export function launchScreen() {
  const screen = el('div', { class: 'screen zelos-launch', role: 'status' }, [
    el('div', { class: 'zelos-launch-brand', 'aria-hidden': 'true' }, [
      el('span', { class: 'zelos-launch-mark' }, ['left', 'right'].map(side =>
        el('span', { class: `zelos-launch-wing zelos-launch-wing--${side}` },
          el('span', { class: 'zelos-wing-motion' },
            [1, 2, 3].map(i => el('span', { class: `zelos-feather zelos-feather--${i}` })))))),
      el('p', { class: 'zelos-launch-name' }, [...'ZELOS'].map(letter => el('span', { class: 'zelos-launch-letter', text: letter }))),
    ]),
    el('p', { class: 'screen-line', text: 'Opening your workspace…' }),
  ]);
  animateLaunch(screen);
  return screen;
}

const activeFlights = new WeakSet();

/** Fresh timing and excursion for each beat; paired wings always share a trajectory. */
export function animateLaunch(screen) {
  if (!screen || activeFlights.has(screen)) return;
  const wings = [...screen.querySelectorAll('.zelos-wing-motion')];
  if (wings.length !== 2 || wings.some(wing => typeof wing.animate !== 'function')) return;
  activeFlights.add(screen);
  requestAnimationFrame(() => {
    if (!screen.isConnected) { activeFlights.delete(screen); return; }
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const random = (low, high) => low + Math.random() * (high - low);
    const pose = angle => `rotate(${angle}deg) scaleX(${angle > 0 ? 1 - angle * .012 : 1 - angle * .002})`;
    let animations = [], revision = 0, folded = 0, disposed = false;
    const hold = angle => wings.forEach(wing => { wing.style.transform = pose(angle); });
    function stop() {
      revision++;
      animations.forEach(animation => animation.cancel());
      animations = [];
      folded = 0;
      hold(0);
    }
    function cleanup() {
      if (disposed) return;
      disposed = true; stop(); observer.disconnect();
      motion.removeEventListener('change', update);
      document.removeEventListener('visibilitychange', update);
      activeFlights.delete(screen);
    }
    function beat() {
      if (disposed) return;
      if (!screen.isConnected) { cleanup(); return; }
      if (motion.matches || document.hidden || animations.length) return;
      const mine = ++revision;
      const open = random(-8.5, -4.5), close = random(1.8, 4.5);
      const apex = random(.37, .49), glide = Math.random() < .22 ? random(.08, .17) : 0;
      const easing = 'cubic-bezier(.45,0,.55,1)';
      const frames = [{ transform: pose(folded), offset: 0, easing }, { transform: pose(open), offset: apex, easing }];
      if (glide) frames.push({ transform: pose(open), offset: apex + glide, easing });
      frames.push({ transform: pose(close), offset: 1 });
      const timing = { duration: random(2400, 3800) + glide * 4000, easing: 'linear', fill: 'forwards' };
      animations = wings.map(wing => wing.animate(frames, timing));
      Promise.all(animations.map(animation => animation.finished)).then(() => {
        if (disposed || mine !== revision) return;
        folded = close; hold(close);
        animations.forEach(animation => animation.cancel()); animations = [];
        beat();
      }).catch(() => { /* Cancellation on navigation or reduced motion is expected. */ });
    }
    function update() {
      if (!screen.isConnected) { cleanup(); return; }
      if (motion.matches || document.hidden) stop();
      else beat();
    }
    const observer = new MutationObserver(() => { if (!screen.isConnected) cleanup(); });
    observer.observe(document.body, { childList: true, subtree: true });
    motion.addEventListener('change', update);
    document.addEventListener('visibilitychange', update);
    update();
  });
}

/** Readiness can finish early; the first launch stays visible for two seconds. */
export function createLaunchHold(onElapsed, {
  now = () => performance.now(), schedule = setTimeout, duration = 2000,
} = {}) {
  const deadline = now() + duration;
  let timer = null, released = false;
  return () => {
    if (released) return false;
    const remaining = deadline - now();
    if (remaining <= 0) { released = true; return false; }
    if (timer === null) timer = schedule(() => {
      timer = null;
      onElapsed();
    }, remaining);
    return true;
  };
}
