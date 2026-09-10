/* Zelos — page behaviour. */

/* The version query is not decoration. /js/* was served immutable for a year,
   so the first redesign to reach the server never reached anyone who had
   already visited — they kept running the previous scripts against the new
   stylesheet. The header is fixed now, but a cache that was poisoned under the
   old rule only lets go if the URL changes. Bump this whenever this file
   changes in a way a returning visitor must see. */
import { createFlow } from './js/flow.js?v=4';
import { createScopes, LANES } from './js/scopes.js?v=3';
import { createGate } from './js/gate.js?v=2';
import { createWires } from './js/wires.js?v=2';
import { createPollen } from './js/pollen.js?v=1';

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ── the backdrop ─────────────────────────────────────────────────────────
   Scroll drives currentTime. The clip is encoded all-intra precisely so this
   is cheap: every frame is a keyframe, so a seek is one decode instead of a
   decode back to the last keyframe.

   Never played, only sought — so nothing here calls play(), except once on the
   first gesture, because iOS will not seek a video the user has never touched. */
function bootBackdrop() {
  const v = document.getElementById('backdrop');
  if (!v) return;
  // Reduced motion gets the poster and no fetch of the film at all.
  if (reduced) { v.removeAttribute('src'); v.load(); return; }
  // Raising preload is enough to start buffering; calling load() as well would
  // abort the request already in flight and log a failure for nothing.
  v.preload = 'auto';

  let target = 0;
  let now = 0;
  let running = false;
  let raf = 0;

  const read = () => {
    const max = Math.max(1, document.documentElement.scrollHeight - innerHeight);
    target = Math.min(1, Math.max(0, scrollY / max));
  };
  addEventListener('scroll', read, { passive: true });
  addEventListener('resize', read);
  read();

  function frame() {
    // Eased rather than pinned: a trackpad flick would otherwise ask for a
    // dozen seeks in as many milliseconds, and the decoder simply drops them.
    now += (target - now) * 0.11;
    const d = v.duration;
    if (d && Number.isFinite(d)) {
      // Never seek to exactly duration — some browsers stall on the last frame
      // and the picture freezes for the rest of the page.
      const t = Math.min(d - 0.04, now * d);
      if (Math.abs(t - v.currentTime) > 0.008) v.currentTime = t;
    }
    if (running) raf = requestAnimationFrame(frame);
  }

  function start() { if (running) return; running = true; raf = requestAnimationFrame(frame); }
  function stop() { running = false; cancelAnimationFrame(raf); }

  if (v.readyState >= 1) start();
  else v.addEventListener('loadedmetadata', start, { once: true });

  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));

  // iOS refuses to seek a media element that has never been started by a user
  // gesture. Play and immediately pause on the first one; it is inaudible and
  // it unlocks seeking for the rest of the session.
  const unlock = () => {
    v.play().then(() => v.pause()).catch(() => {});
    removeEventListener('touchstart', unlock);
    removeEventListener('pointerdown', unlock);
  };
  addEventListener('touchstart', unlock, { once: true, passive: true });
  addEventListener('pointerdown', unlock, { once: true, passive: true });
}

/* ── pollen ───────────────────────────────────────────────────────────────
   Unconditional: the canvas decides for itself whether to run a loop or settle
   to one frame, because reduced motion should still get the atmosphere. */
function bootPollen() {
  const c = document.querySelector('.motes');
  if (c) createPollen(c);
}

/* ── the reading veil ─────────────────────────────────────────────────────
   The hero wants the doorway at full strength and every paragraph below it
   wants something between the film and the type. One scrim cannot do both, so
   the stylesheet keeps a base wash that never moves and this drives a second
   flat layer on top of it: open across the first screenful, closed by the time
   the first section arrives.

   Opacity only, on a fixed viewport-sized layer — the compositor handles it and
   nothing repaints. The stylesheet's default is 1, so the protected page is
   what you get with no JavaScript, and reduced motion simply leaves it there
   rather than fading anything. */
function armVeil() {
  if (reduced) return;               // the stylesheet's 1 stands: nothing to follow
  // Only the page with a hero has a screenful worth opening for. On /privacy the
  // first thing on screen is a paragraph, and opening the veil under it would
  // sit that paragraph on the brightest part of the picture.
  if (!document.querySelector('.hero')) return;
  const root = document.documentElement;
  let ticking = false;
  const apply = () => {
    ticking = false;
    const open = innerHeight * 0.18;         // held open this far down
    const span = Math.max(1, innerHeight * 0.62);   // and closed this much later
    const t = Math.min(1, Math.max(0, (scrollY - open) / span));
    root.style.setProperty('--veil', t.toFixed(3));
  };
  addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(apply);
    // rAF never fires in a backgrounded tab and the flag would stick on
    setTimeout(() => { if (ticking) apply(); }, 250);
  }, { passive: true });
  addEventListener('resize', apply);
  apply();
}

/* ── entrance ─────────────────────────────────────────────────────────────
   Same contract as everywhere else: content is visible at rest, the class is
   only added by JS, and a hard timer guarantees nothing stays hidden. */
function armReveals() {
  const targets = document.querySelectorAll(
    '.pane, .card, .shot, .band-head, .coda, .plates, .note, .limits, .foot-inner, .band-payoff > *, .ask'
  );
  if (reduced || !('IntersectionObserver' in window)) return;

  for (const el of targets) el.classList.add('rise');

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add('in');
      io.unobserve(e.target);
    }
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.05 });

  for (const el of targets) io.observe(el);
  setTimeout(() => { for (const el of targets) el.classList.add('in'); }, 1200);
}

/* ── nav ──────────────────────────────────────────────────────────────────── */
function armNav() {
  const nav = document.querySelector('.nav');
  if (!nav) return;
  let ticking = false;
  const apply = () => { nav.toggleAttribute('data-scrolled', scrollY > 8); ticking = false; };
  addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(apply);
    // rAF never fires in a backgrounded tab and the flag would stick on
    setTimeout(() => { if (ticking) apply(); }, 250);
  }, { passive: true });
  apply();
}

/* ── downloads ────────────────────────────────────────────────────────────── */
/**
 * Is this Mac Apple silicon? Returns true, false, or null for "cannot tell".
 *
 * It matters because the Mac plate's big Download is the arm64 disk image, and
 * Rosetta does not translate ARM to x86 — an Intel Mac that takes it gets an
 * app that refuses to open, with a message that has no "Open Anyway" in it, so
 * the "Is it safe?" box beneath would be teaching the wrong diagnosis.
 *
 * Neither `navigator.platform` nor `userAgentData.platform` carries an
 * architecture, so the only synchronous signal is the GPU string: on Apple
 * silicon it begins "Apple M" (M1, M2, …), and on an Intel Mac it names AMD,
 * Intel or Radeon. A blocked or software-backed WebGL context answers nothing,
 * which is why null is a real return value and not a failure.
 */
function appleSilicon() {
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    if (!gl) return null;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = String(
      ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) || '',
    );
    if (!renderer) return null;
    if (/apple\s*m\d/i.test(renderer)) return true;
    if (/(intel|amd|radeon|nvidia|geforce)/i.test(renderer)) return false;
    return null;
  } catch {
    return null;
  }
}

/**
 * Promote the visitor's own platform: its plate goes first, grows, and is
 * labelled for the person ("For your Mac") rather than for the file. The
 * stylesheet does the rest off `data-yours` on the grid and on the plate.
 *
 * A Mac is promoted whether or not its architecture can be read. The old rule
 * — badge only an Apple-silicon Mac, say nothing otherwise — existed because
 * "your machine" was a claim about one specific file. "For your Mac" is a
 * claim about the plate, and the plate carries both files plus the
 * About-This-Mac line for choosing between them, so the visitor makes that
 * call. The one thing still done for them: when the GPU string says Intel
 * outright, the big button is pointed at the Intel image, because the default
 * click must never be the one file that refuses to open.
 *
 * The Mac plate is a <div> with a stretched link inside (nested anchors get
 * hoisted by the parser), so the selector matches on the class, not the tag.
 */
/**
 * 'mac', 'win', or null when the browser says neither. One reader for the two
 * places that promote the visitor's own computer — the download plates here
 * and the first-open cards on /help — so they can never disagree about whose
 * machine this is.
 */
function platform() {
  const p = navigator.userAgentData?.platform || navigator.platform || '';
  const ua = navigator.userAgent;
  if (/mac/i.test(p) || /Mac OS X/.test(ua)) return 'mac';
  if (/win/i.test(p) || /Windows/.test(ua)) return 'win';
  return null;
}

function markPlatform() {
  const want = platform();

  const plates = document.querySelector('[data-plates]');
  const plate = want && plates && plates.querySelector(`.plate[data-dl="${want}"]:not(.plate-soon)`);
  if (!plate) return;

  plate.dataset.yours = 'true';
  plates.dataset.yours = want;
  plates.prepend(plate);
  const os = plate.querySelector('.plate-os');
  if (os && plate.dataset.yoursLabel) os.textContent = plate.dataset.yoursLabel;

  if (want === 'mac' && appleSilicon() === false) {
    const primary = plate.querySelector('.plate-link');
    const meta = plate.querySelector('.plate-meta');
    const alt = plate.querySelector('.plate-alt');
    if (primary) {
      primary.href = '/downloads/Zelos-mac-intel.dmg';
      primary.setAttribute('aria-label', 'Download Zelos for an Intel Mac');
    }
    if (meta) meta.textContent = 'Intel';
    if (alt) {
      alt.textContent = '';
      alt.append('Apple silicon? ');
      const a = document.createElement('a');
      a.href = '/downloads/Zelos-mac-apple-silicon.dmg';
      a.setAttribute('download', '');
      a.textContent = 'take this one';
      alt.append(a);
    }
  }
}

/**
 * Show the real size of the source download rather than a number baked into the
 * copy, which goes stale the moment the bundle is rebuilt.
 */
async function realSize() {
  const el = document.querySelector('[data-size-src]');
  if (!el) return;
  try {
    const r = await fetch('/release.json');
    const release = await r.json();
    const len = Number(release.assets?.find((asset) => asset.name === 'zelos-source.zip')?.size);
    if (!len) return;
    el.textContent = `${Math.round(len / 1024)} KB · macOS, Windows, Linux`;
  } catch { /* leave the static text */ }
}

/* The winnowing diagram. Only runs while it is actually on screen — it is a
   continuously animating canvas and there is no reason to burn a phone battery
   on one that is three screens away. */
function bootFlow() {
  const canvas = document.getElementById('flow');
  if (!canvas) return;
  let flow;
  try { flow = createFlow(canvas); } catch { canvas.remove(); return; }
  if (!flow) { canvas.remove(); return; }
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((entries) => {
      for (const e of entries) e.isIntersecting ? flow.start() : flow.stop();
    }, { threshold: 0.08 }).observe(canvas);
  } else {
    flow.start();
  }
}

/* Only run a canvas while it is actually on screen. Each of these is a
   continuously animating loop and there is no reason to burn a phone battery on
   one that is three screens away. */
function whileVisible(canvas, anim, threshold = 0.08) {
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((entries) => {
      for (const e of entries) e.isIntersecting ? anim.start() : anim.stop();
    }, { threshold }).observe(canvas);
  } else {
    anim.start();
  }
}

/* The two runs of the egress diagram. Atmosphere with a job: the copy beside
   each one says the same thing in words, so a canvas that cannot start is
   removed rather than left as an empty box. */
function bootWires() {
  for (const canvas of document.querySelectorAll('[data-wires]')) {
    let anim;
    try { anim = createWires(canvas, { mode: canvas.dataset.wires }); } catch { anim = null; }
    if (!anim) { canvas.remove(); continue; }
    whileVisible(canvas, anim);
  }
}

/* The AI-access picker, and the wall it drives. It is a real control rather
   than a picture of one, so a failure here must not take the section down with
   it — the copy around it says the same thing in words. */
function bootScopes() {
  const root = document.querySelector('[data-scopes]');
  if (!root) return;
  let gate = null;
  const canvas = root.querySelector('[data-gate]');
  if (canvas) {
    try { gate = createGate(canvas, LANES); } catch { gate = null; }
    if (!gate) canvas.remove();
  }
  try { createScopes(root, gate); } catch { root.remove(); return; }
  if (gate && canvas) whileVisible(canvas, gate);
}

/* ── help: "Ask Claude to walk me through this" ──────────────────────────
   /help carries one card per setup step, each with a message Zelos wrote for
   Claude in a <textarea>, a link that opens claude.ai with that message in the
   q= parameter, and a Copy button. Three jobs here, none of which the page
   needs to be readable — every link is baked into the HTML and works with no
   script at all:

   1. The visitor's own computer goes first under "Opening Zelos the first
      time", the way their download plate does, off the same platform().
   2. The links are re-derived from the textareas. The HTML carries both, and
      a person editing the message edits the prose; this keeps the link equal
      to it even when the bake step was forgotten.
   3. Copy. The clipboard API needs a user gesture and a secure context, which
      a click on an https page is; where it is refused anyway — an old
      browser, a locked-down one — the fold opens and the text is selected,
      so the person can copy it themselves and the button says so.

   What is never here: anything about the person. The messages are fixed text,
   and nothing on this page reads an address, a key or a path to put in one. */
function armHelp() {
  const root = document.querySelector('[data-help]');
  if (!root) return;

  const want = platform();
  const mine = want && root.querySelector(`.ask[data-platform="${want}"]`);
  if (mine) {
    mine.dataset.yours = 'true';
    mine.parentElement.prepend(mine);
  }

  for (const ta of root.querySelectorAll('textarea[data-prompt]')) {
    const card = ta.closest('.ask');
    if (!card) continue;
    const q = encodeURIComponent(ta.value);
    const claude = card.querySelector('[data-open="claude"]');
    const chatgpt = card.querySelector('[data-open="chatgpt"]');
    if (claude) claude.href = `https://claude.ai/new?q=${q}`;
    if (chatgpt) chatgpt.href = `https://chatgpt.com/?q=${q}`;
  }

  root.addEventListener('click', async (event) => {
    const btn = event.target.closest('.ask-copy');
    if (!btn) return;
    const card = btn.closest('.ask');
    const ta = card && card.querySelector('textarea[data-prompt]');
    if (!ta) return;
    const label = btn.dataset.label || (btn.dataset.label = btn.textContent);

    // Open the fold and select the text. Done before the older copy path,
    // which copies the selection, and left open after a failure, which is
    // then the person's own copy to make.
    const reveal = () => {
      const fold = card.querySelector('details');
      if (fold) fold.open = true;
      ta.focus();
      ta.select();
    };

    let copied = false;
    try {
      await navigator.clipboard.writeText(ta.value);
      copied = true;
    } catch {
      reveal();
      try { copied = document.execCommand('copy'); } catch { copied = false; }
    }

    if (copied) {
      btn.textContent = 'Copied — now press Ask Claude';
      btn.classList.add('is-copied');
    } else {
      reveal();
      btn.textContent = 'Select the text below and copy it';
    }
    clearTimeout(btn._restore);
    btn._restore = setTimeout(() => {
      btn.textContent = label;
      btn.classList.remove('is-copied');
    }, 4000);
  });
}

const boot = () => {
  bootBackdrop(); bootPollen(); bootFlow(); bootWires(); bootScopes();
  armVeil(); armReveals(); armNav(); markPlatform(); realSize(); armHelp();
};
if (document.readyState === 'loading') addEventListener('DOMContentLoaded', boot);
else boot();
