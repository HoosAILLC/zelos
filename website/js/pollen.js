/*
 * Pollen.
 *
 * The film behind the page is full of drifting motes, and they stop dead at the
 * edge of the video — which is what makes a photographic backdrop read as a
 * picture the site is standing in front of rather than the room it is in. This
 * carries the same motes across the whole viewport: a fixed field of slow gold
 * specks that rise, wander and fade, in front of the scrim so they stay in the
 * air rather than under it.
 *
 * Deliberately cheap, because it is behind everything and nobody should ever be
 * able to point at it:
 *   - density is per square pixel of viewport, capped, so a 27" display does not
 *     get a blizzard and a phone does not get four specks;
 *   - wall-clock paced, so a throttled tab resumes where it was instead of
 *     fast-forwarding through a minute of drift (the same rule as flow.js);
 *   - stopped entirely while the tab is hidden;
 *   - one settled frame and no loop at all under prefers-reduced-motion — the
 *     atmosphere survives, the movement does not.
 */

/* Warm, and never white: a white speck on this page reads as a dead pixel. The
   three are the top of the fall — core, gold, honey — so the motes are lit by
   the same light as everything else. */
const TINTS = ['240,233,174', '232,208,138', '217,169,106'];

const AREA_PER_MOTE = 15000;   // px² of viewport
const MAX_MOTES = 90;

export function createPollen(canvas) {
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return null;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let w = 0;
  let h = 0;
  let dpr = 1;
  let motes = [];

  function spawn(seeded) {
    return {
      x: Math.random() * w,
      // A fresh mote enters from just below the frame; a seeded one is already
      // somewhere in the room, or the field arrives as a rising curtain.
      y: seeded ? Math.random() * h : h + Math.random() * 40,
      r: 0.6 + Math.random() * 1.7,
      // Upward, slowly, and never at exactly one speed — a field that shares a
      // velocity reads as a texture scrolling rather than as air.
      vy: -(4 + Math.random() * 13),
      drift: (Math.random() - 0.5) * 9,
      // The wander: a slow sine across the mote's own path, so it wobbles the
      // way something that light actually falls through air.
      phase: Math.random() * 6.283,
      swing: 6 + Math.random() * 16,
      rate: 0.18 + Math.random() * 0.3,
      alpha: 0.18 + Math.random() * 0.34,
      tint: TINTS[(Math.random() * TINTS.length) | 0],
      t: Math.random() * 40,
    };
  }

  function resize() {
    const iw = innerWidth;
    const ih = innerHeight;
    dpr = Math.min(devicePixelRatio || 1, 2);
    w = iw;
    h = ih;
    canvas.width = Math.round(iw * dpr);
    canvas.height = Math.round(ih * dpr);
    canvas.style.width = iw + 'px';
    canvas.style.height = ih + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const want = Math.min(MAX_MOTES, Math.max(14, Math.round((iw * ih) / AREA_PER_MOTE)));
    while (motes.length > want) motes.pop();
    while (motes.length < want) motes.push(spawn(true));
  }

  function draw() {
    ctx.clearRect(0, 0, w, h);
    // Additive: two motes that cross brighten rather than punching a hole in
    // each other, which is what light does and what alpha compositing does not.
    ctx.globalCompositeOperation = 'lighter';
    for (const m of motes) {
      const x = m.x + Math.sin(m.phase + m.t * m.rate) * m.swing;
      // Fade in off the bottom edge and out again at the top, so nothing ever
      // appears or vanishes at a hard line.
      const edge = Math.min(1, (h - m.y) / 90, m.y / 120);
      const a = m.alpha * Math.max(0, edge);
      if (a <= 0.002) continue;
      ctx.fillStyle = `rgba(${m.tint},${a.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(x, m.y, m.r, 0, 6.283);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  function step(dt) {
    for (let i = 0; i < motes.length; i++) {
      const m = motes[i];
      m.t += dt;
      m.y += m.vy * dt;
      m.x += m.drift * dt;
      if (m.y < -20 || m.x < -60 || m.x > w + 60) motes[i] = spawn(false);
    }
  }

  let raf = 0;
  let last = 0;
  let running = false;

  function frame(now) {
    if (!running) return;
    // Clamped: a tab that was hidden for a minute must not teleport the field.
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016;
    last = now;
    step(dt);
    draw();
    raf = requestAnimationFrame(frame);
  }

  function start() {
    if (running || reduced) return;
    running = true;
    last = 0;
    raf = requestAnimationFrame(frame);
  }
  function stop() { running = false; cancelAnimationFrame(raf); }

  addEventListener('resize', () => { resize(); if (reduced) draw(); }, { passive: true });
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));

  resize();
  if (reduced) draw();
  else start();

  return { start, stop };
}
