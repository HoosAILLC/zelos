import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createWebsiteLaunch, initWebsiteLaunch } from '../website/js/loading.js';
import { installDom } from './helpers/ui-dom.mjs';

function fixture(t, { reduced = false, hash = '', supported = true, animate } = {}) {
  const document = installDom(t), window = globalThis.window;
  document.querySelector = selector => document.body.querySelector(selector);
  document.querySelectorAll = selector => document.body.querySelectorAll(selector);
  document.removeEventListener = (name, fn) => document.listeners.set(name, (document.listeners.get(name) || []).filter(item => item !== fn));
  const create = document.createElement.bind(document);
  document.createElement = tag => {
    const node = create(tag);
    node.hasAttribute = key => node.getAttribute(key) !== null;
    if (supported) {
      node.showPopover = function () { this.popoverOpen = true; this.fire('toggle', {newState: 'open'}); };
      node.hidePopover = function () { this.popoverOpen = false; this.fire('toggle', {newState: 'closed'}); };
    }
    if (animate) node.animate = animate;
    return node;
  };
  const timers = new Map(); let timerId = 0;
  window.setTimeout = (fn, duration) => {timers.set(++timerId, {fn, duration}); return timerId;};
  window.clearTimeout = id => timers.delete(id);
  const storage = new Map();
  window.sessionStorage = {getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value)};
  window.location.hash = hash;
  const motionListeners = new Set();
  const motion = {matches: reduced, addEventListener: (_, fn) => motionListeners.add(fn), removeEventListener: (_, fn) => motionListeners.delete(fn)};
  window.matchMedia = () => motion;
  const main = document.body.appendChild(document.createElement('main'));
  const replay = document.body.appendChild(document.createElement('button'));
  replay.setAttribute('data-replay-launch', ''); replay.hidden = true;
  document.activeElement = document.body;
  const tick = () => {const entries = [...timers.values()]; timers.clear(); entries.forEach(({fn}) => fn());};
  return {document, window, main, replay, timers, motion, motionListeners, tick};
}

test('unsupported browsers preserve the page and leave replay hidden', t => {
  const f = fixture(t, {supported: false});
  assert.equal(initWebsiteLaunch(f), null);
  assert.equal(f.document.body.children.length, 2);
  assert.equal(f.main.hidden, false);
  assert.equal(f.replay.hidden, true);
});

test('the intro lasts three seconds, automatic only once per session, with no content lock', t => {
  const f = fixture(t), launch = initWebsiteLaunch(f);
  assert.equal(launch.isOpen, true);
  assert.equal(f.timers.size, 1);
  assert.equal([...f.timers.values()][0].duration, 3000);
  assert.equal(f.replay.hidden, false);
  assert.equal(f.main.hidden, false);
  assert.equal(f.main.hasAttribute('inert'), false);
  assert.equal(launch.screen.querySelectorAll('.site-feather').length, 6);
  assert.equal(launch.screen.querySelectorAll('.site-launch-letter').length, 5);
  f.tick();
  assert.equal(launch.isOpen, false);
  assert.equal(f.document.activeElement, f.main);
  launch.destroy();
  const again = initWebsiteLaunch(f);
  assert.equal(again.isOpen, false);
  again.destroy();
});

test('Skip, Escape, Tab and native dismissal release focus and timers; replay runs afresh', t => {
  const f = fixture(t), launch = createWebsiteLaunch(f);
  f.replay.focus();
  for (const method of ['skip', 'Escape', 'Tab', 'native']) {
    launch.play(); launch.play();
    assert.equal(f.timers.size, 1, 'repeated play cannot extend the opening');
    const skip = launch.screen.querySelector('button');
    assert.equal(skip.getAttribute('popovertargetaction'), 'hide');
    assert.equal(skip.getAttribute('popovertarget'), 'zelos-site-launch');
    if (method === 'skip') skip.click();
    else if (method === 'native') launch.screen.hidePopover();
    else skip.fire('keydown', {key: method});
    assert.equal(launch.isOpen, false);
    assert.equal(f.timers.size, 0);
    assert.equal(f.document.activeElement, f.replay);
  }
  launch.destroy(); assert.equal(launch.play(), false);
});

for (const [reason, options] of [['reduced motion', {reduced: true}], ['deep links', {hash: '#download'}]]) {
  test(`${reason} skips autoplay but keeps explicit replay`, t => {
    const f = fixture(t, options), launch = initWebsiteLaunch(f);
    assert.equal(launch.isOpen, false);
    f.replay.focus(); f.replay.click();
    assert.equal(launch.isOpen, true);
    launch.destroy();
  });
}

test('blocked storage and an animation setup failure cannot strand the page', t => {
  const f = fixture(t, {animate() {return {cancel() {}, finished: new Promise(() => {})};}});
  f.window.sessionStorage = {getItem() {throw Error('blocked');}, setItem() {throw Error('blocked');}};
  let matches = 0;
  f.window.matchMedia = () => {if (++matches > 1) throw Error('unavailable'); return f.motion;};
  const launch = initWebsiteLaunch(f);
  assert.equal(launch.isOpen, false);
  assert.equal(f.timers.size, 0);
  assert.equal(f.main.hidden, false);
  launch.destroy();
});

test('pausing site motion on another page suppresses the automatic opening', t => {
  const f = fixture(t);
  f.window.sessionStorage.setItem('zelos.site-motion', 'paused');
  const launch = initWebsiteLaunch(f);
  assert.equal(launch.isOpen, false);
  assert.equal(f.timers.size, 0);
  assert.equal(f.replay.hidden, false);
  launch.destroy();
});

test('wing motion uses paired frames, stops when hidden or reduced, and cleans up', t => {
  const calls = [], f = fixture(t, {animate(frames, timing) {
    const animation = {frames, timing, cancelled: false, cancel() {this.cancelled = true;}, finished: new Promise(() => {})};
    calls.push(animation); return animation;
  }});
  const launch = createWebsiteLaunch(f); launch.play();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].frames, calls[1].frames);
  assert.deepEqual(calls[0].timing, calls[1].timing);
  f.document.hidden = true;
  f.document.listeners.get('visibilitychange').forEach(fn => fn());
  assert.ok(calls.every(animation => animation.cancelled));
  f.document.hidden = false;
  f.document.listeners.get('visibilitychange').forEach(fn => fn());
  assert.equal(calls.length, 4);
  f.motion.matches = true; f.motionListeners.forEach(fn => fn());
  assert.ok(calls.every(animation => animation.cancelled));
  launch.destroy();
  assert.equal(f.motionListeners.size, 0);
  assert.equal(f.document.listeners.get('visibilitychange').length, 0);
});

test('a failure starting the second wing cancels the first and preserves the timed exit', t => {
  let started = 0, cancelled = 0;
  const f = fixture(t, {animate() {
    if (++started === 2) throw Error('animation unavailable');
    return {cancel() {cancelled++;}, finished: new Promise(() => {})};
  }});
  const launch = createWebsiteLaunch(f);
  assert.equal(launch.play(), true);
  assert.equal(cancelled, 1);
  assert.equal(f.timers.size, 1);
  f.tick();
  assert.equal(launch.isOpen, false);
  assert.equal(f.motionListeners.size, 0);
  launch.destroy();
});

test('the independent CSS escape remains enabled under reduced motion', () => {
  const css = fs.readFileSync(new URL('../website/loading.css', import.meta.url), 'utf8');
  assert.match(css, /site-launch-failsafe 1ms step-end 3000ms forwards/);
  assert.match(css, /@keyframes site-launch-failsafe \{ to \{ opacity: 0; visibility: hidden; pointer-events: none;/);
  assert.match(css, /\.site-launch:not\(:popover-open\) \{ display: none; \}/);
  assert.doesNotMatch(css.slice(css.indexOf('@media (prefers-reduced-motion')), /\.site-launch\s*\{[^}]*animation:\s*none/);
});
