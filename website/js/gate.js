/**
 * gate.js — the scope wall.
 *
 * Six streams, one per scope, running from the things Zelos holds toward an
 * assistant you connected. A stream whose scope is ticked passes the wall and
 * arrives. A stream whose scope is off reaches the wall and dies there — not
 * arrives-but-redacted, dies, which is what the application actually does: the
 * tool is absent from `tools/list` and refused by name if asked for anyway.
 *
 * The picker drives this directly, so the animation is not an illustration of
 * the scope state, it *is* the scope state.
 *
 * Same contract as the other canvases: wall-clock paced, paused off-screen and
 * when hidden, one settled frame under prefers-reduced-motion.
 */

export function createGate(canvas, lanes) {
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return null;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let w = 0;
  let h = 0;
  let dpr = 1;
  let live = new Set();      // scope ids currently passing
  let enabled = false;

  function resize() {
    const r = canvas.getBoundingClientRect();
    dpr = Math.min(devicePixelRatio || 1, 2);
    w = Math.max(260, Math.round(r.width));
    h = Math.max(150, Math.round(r.height));
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  const inX = () => w * 0.06;
  const wallX = () => w * 0.52;
  const outX = () => w * 0.88;
  const laneY = (i) => h * (0.13 + (i / (lanes.length - 1)) * 0.74);

  const parts = [];
  const spawn = (i) => ({
    lane: i, t: 0,
    speed: 0.34 + Math.random() * 0.2,
    r: 1.25 + Math.random() * 0.95,
    wob: (Math.random() - 0.5) * h * 0.03,
    seed: Math.random() * 6.28,
    // Decided at spawn: a dot that set off while the scope was on is not
    // retroactively confiscated when you untick it. The stream simply stops.
    pass: enabled && live.has(lanes[i].id),
    stopped: 0,
  });

  function step(p, dt) {
    if (p.pass) { p.t += p.speed * dt; return p.t < 1; }
    // Blocked: run to the wall, then fade in place.
    if (p.t < 1) { p.t = Math.min(1, p.t + p.speed * dt * 1.6); return true; }
    p.stopped += dt;
    return p.stopped < 0.55;
  }

  function place(p) {
    const y0 = laneY(p.lane);
    if (p.pass) {
      const x = inX() + (outX() - inX()) * p.t;
      // Converge on the assistant once past the wall.
      const k = Math.max(0, (x - wallX()) / (outX() - wallX()));
      const y = y0 + (h * 0.5 - y0) * (k * k) + Math.sin(p.t * 3 + p.seed) * p.wob;
      return { x, y };
    }
    const x = inX() + (wallX() - inX()) * p.t;
    return { x, y: y0 + Math.sin(p.t * 3 + p.seed) * p.wob };
  }

  function drawChrome() {
    ctx.font = '400 9.5px ui-monospace, "SF Mono", Menlo, monospace';
    ctx.textBaseline = 'middle';

    // lane labels
    for (let i = 0; i < lanes.length; i++) {
      const on = enabled && live.has(lanes[i].id);
      ctx.fillStyle = on ? lanes[i].colour : 'rgba(158,158,158,.45)';
      ctx.globalAlpha = on ? 0.9 : 0.55;
      ctx.fillText(lanes[i].short, 4, laneY(i));
    }
    ctx.globalAlpha = 1;

    // the wall
    const g = ctx.createLinearGradient(0, h * 0.04, 0, h * 0.96);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.5, enabled ? 'rgba(255,255,255,.22)' : 'rgba(255,255,255,.34)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(wallX() - 0.5, h * 0.04, 1, h * 0.92);

    // and the assistant it guards
    ctx.beginPath();
    ctx.arc(outX(), h * 0.5, 3.6, 0, 6.283);
    const anyLive = enabled && live.size > 0;
    ctx.fillStyle = anyLive ? 'rgba(236,236,236,.95)' : 'rgba(158,158,158,.45)';
    if (anyLive) { ctx.shadowBlur = 12; ctx.shadowColor = 'rgba(255,255,255,.7)'; }
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = anyLive ? 'rgba(220,220,220,.85)' : 'rgba(158,158,158,.5)';
    const t = 'YOUR AI';
    ctx.fillText(t, Math.min(w - ctx.measureText(t).width - 2, outX() - ctx.measureText(t).width / 2),
      h * 0.5 - 16);
  }

  let running = false;
  let raf = 0;
  let last = 0;
  let carry = 0;

  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;

    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = 'rgba(0,0,0,.3)';
    ctx.fillRect(0, 0, w, h);
    drawChrome();

    // Only emit from lanes that hold something. With access off nothing sets
    // off at all — there is no stream to block.
    carry += dt * 13 * Math.min(1.3, w / 380);
    while (carry >= 1) {
      carry -= 1;
      if (!enabled && Math.random() > 0.45) continue;   // a trickle, to show the wall holding
      parts.push(spawn((Math.random() * lanes.length) | 0));
    }

    ctx.globalCompositeOperation = 'lighter';
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      if (!step(p, dt)) { parts.splice(i, 1); continue; }
      const q = place(p);
      const lane = lanes[p.lane];
      if (p.pass) {
        ctx.shadowBlur = 8; ctx.shadowColor = lane.colour;
        ctx.fillStyle = lane.colour;
      } else {
        ctx.shadowBlur = 0;
        const a = p.t < 1 ? 0.5 : Math.max(0, 0.5 - p.stopped * 0.9);
        ctx.fillStyle = `rgba(158,158,158,${a})`;
      }
      ctx.beginPath();
      ctx.arc(q.x, q.y, p.r, 0, 6.283);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
    ctx.globalCompositeOperation = 'source-over';

    if (running) raf = requestAnimationFrame(frame);
  }

  function prime() {
    if (parts.length) return;
    for (let i = 0; i < 46; i++) {
      const p = spawn((Math.random() * lanes.length) | 0);
      p.t = Math.random();
      parts.push(p);
    }
  }

  function settle() {
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, w, h);
    parts.length = 0;
    prime();
    drawChrome();
    for (const p of parts) {
      const q = place(p);
      ctx.fillStyle = p.pass ? lanes[p.lane].colour : 'rgba(158,158,158,.4)';
      ctx.beginPath();
      ctx.arc(q.x, q.y, p.r, 0, 6.283);
      ctx.fill();
    }
  }

  function setState(nextEnabled, nextLive) {
    enabled = nextEnabled;
    live = new Set(nextLive);
    if (reduced) settle();
  }

  function start() {
    if (running) return;
    if (reduced) { resize(); settle(); return; }
    prime();
    running = true;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }
  function stop() { running = false; cancelAnimationFrame(raf); }

  resize();
  addEventListener('resize', () => { resize(); if (reduced) settle(); });
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));

  return { start, stop, setState, resize };
}
