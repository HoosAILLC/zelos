/**
 * demo/demo-banner.js — the strip that says this is not your data.
 *
 * It lives outside `#app` deliberately. The app replaces the whole of `#app` on
 * every route change, so anything inside it would have to be re-added by the
 * app's own render loop — which would mean editing app.js, and the point of this
 * directory is that app.js is the real one, untouched.
 *
 * Nodes are built, never assembled from a string, for the same reason the app
 * does it: there is no innerHTML path in here for anything to slip through.
 */

const DOWNLOAD_URL = '/#download';

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined) continue;
    if (key === 'text') node.textContent = String(value);
    else if (key === 'class') node.setAttribute('class', value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, String(value));
  }
  for (const child of [].concat(children)) {
    if (child) node.appendChild(child);
  }
  return node;
}

/**
 * The extra clause on Settings. Every field there looks like it wants a real
 * credential, and someone will try — so say plainly, at the moment it is
 * relevant, that the value is thrown away unread.
 */
const warn = el('span', {
  class: 'demo-bar-warn',
  text: 'Credential fields here are inert — nothing typed into one is stored or sent.',
  hidden: true,
});

function syncRoute() {
  const onSettings = (window.location.hash || '').startsWith('#/settings');
  warn.hidden = !onSettings;
}

function build() {
  const bar = el('div', { class: 'demo-bar', role: 'note', 'aria-label': 'Demo notice' }, [
    el('span', { class: 'demo-bar-tag', text: 'Earlier release demo' }),
    el('p', { class: 'demo-bar-text' }, [
      el('span', { class: 'demo-bar-em', text: 'This is a demo. The data is invented and nothing is saved' }),
      el('span', { text: ' — this is the earlier interface. Reload and the board starts over. ' }),
      warn,
    ]),
    el('div', { class: 'demo-bar-actions' }, [
      el('a', { class: 'demo-bar-link', href: '/#walkthrough', text: 'See the new app' }),
      el('button', {
        type: 'button',
        class: 'demo-bar-btn',
        text: 'Start over',
        onclick: () => {
          // A plain reload already resets the board — the whole dataset lives in
          // memory. These two keys are the only things the app writes down at
          // all, so "start over" clears them too rather than nearly resetting.
          try {
            localStorage.removeItem('zelos.accent');
            localStorage.removeItem('zelos.onboarded');
          } catch {
            /* storage disabled: the reload below is still a full reset */
          }
          window.location.reload();
        },
      }),
      el('a', {
        class: 'demo-bar-link',
        href: DOWNLOAD_URL,
        text: 'Download Zelos',
      }),
    ]),
  ]);

  document.body.insertBefore(bar, document.body.firstChild);

  // The strip wraps to two lines on a phone, and the app's chrome sticks
  // beneath it — so its height is measured rather than assumed. A constant here
  // would be wrong at exactly the width where it matters most.
  const measure = () => {
    const h = Math.round(bar.getBoundingClientRect().height);
    if (h) document.documentElement.style.setProperty('--demo-bar-h', `${h}px`);
  };
  measure();
  if (typeof ResizeObserver === 'function') new ResizeObserver(measure).observe(bar);
  else window.addEventListener('resize', measure);

  window.addEventListener('hashchange', syncRoute);
  syncRoute();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', build, { once: true });
} else {
  build();
}
