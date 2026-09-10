/**
 * wires.js — where your mail goes, animated.
 *
 * Two runs of the same machine with one thing changed, and the difference is
 * something you watch rather than read: mail arrives from your own servers,
 * crosses into the machine, and then either goes to a model that is *inside*
 * the boundary or out through the wall to somebody else's.
 *
 * The rule the picture has to carry is that the boundary is real. In `local`
 * nothing ever crosses the right wall; in `hosted` a hot stream crosses it
 * continuously, and that stream is the mail itself. Everything else — the
 * inbound fetches, the box, the labels — is identical between the two, because
 * everything else genuinely is.
 *
 * Paced by wall clock, paused off-screen and when hidden, and reduced to one
 * settled frame under prefers-reduced-motion. Same contract as flow.js.
 */

const GREY = 'rgba(176,180,164,.62)';
const COOL = '#A8C25A';   // decided, and decided at home
const HOT = '#C87A4E';    // crossing the boundary

export function createWires(canvas, { mode = 'local' } = {}) {
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return null;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const hosted = mode === 'hosted';

  let w = 0;
  let h = 0;
  let dpr = 1;

  function resize() {
    const r = canvas.getBoundingClientRect();
    dpr = Math.min(devicePixelRatio || 1, 2);
    w = Math.max(280, Math.round(r.width));
    h = Math.max(200, Math.round(r.height));
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* Geometry, all proportional. The box is deliberately off-centre-left so the
     hosted run has somewhere to put a provider without the frame getting tight. */
  const box = () => ({ x0: w * 0.30, x1: w * 0.70, y0: h * 0.15, y1: h * 0.85 });
  const srcX = () => w * 0.07;
  const imapY = () => h * 0.30;
  const calY = () => h * 0.70;
  const indexX = () => w * 0.40;
  const midY = () => h * 0.50;
  const workX = () => (hosted ? w * 0.86 : w * 0.61);

  /* ── particles ──────────────────────────────────────────────────────────
     Two kinds. `in` walks a source into the index and stops there. `work`
     leaves the index for wherever the model lives and comes back; in hosted
     mode that path happens to pass through the wall, which is the whole point
     and is not special-cased anywhere. */
  const parts = [];
  const spawnIn = (from) => ({
    kind: 'in', from, t: 0, speed: 0.42 + Math.random() * 0.3,
    wob: (Math.random() - 0.5) * h * 0.05, r: 1.3 + Math.random() * 0.9,
    seed: Math.random() * 6.28,
  });
  const spawnWork = () => ({
    kind: 'work', t: 0, speed: 0.30 + Math.random() * 0.16,
    wob: (Math.random() - 0.5) * h * 0.10, r: hosted ? 1.9 + Math.random() * 1.1
      : 1.5 + Math.random() * 0.9,
    seed: Math.random() * 6.28,
  });

  function place(p) {
    if (p.kind === 'in') {
      const e = p.t * p.t * (3 - 2 * p.t);
      const y0 = p.from === 'imap' ? imapY() : calY();
      return {
        x: srcX() + (indexX() - srcX()) * e,
        y: y0 + (midY() - y0) * e + Math.sin(p.t * 3.2 + p.seed) * p.wob * (1 - p.t),
        colour: GREY, glow: false,
      };
    }
    // out and back: t runs 0..2, the fold at 1
    const out = p.t <= 1;
    const u = out ? p.t : 2 - p.t;
    const e = u * u * (3 - 2 * u);
    const x = indexX() + (workX() - indexX()) * e;
    const y = midY() + Math.sin(e * Math.PI) * p.wob;
    return {
      x, y,
      colour: hosted ? HOT : (out ? GREY : COOL),
      glow: hosted || !out,
    };
  }

  function step(p, dt) {
    p.t += p.speed * dt;
    return p.kind === 'in' ? p.t < 1 : p.t < 2;
  }

  /* ── chrome ─────────────────────────────────────────────────────────────── */
  /* Centred on the node, but never past either edge — the provider sits close
     enough to the right that its label would otherwise be cut in half. */
  function centred(text, x) {
    const tw = ctx.measureText(text).width;
    return Math.max(3, Math.min(w - tw - 3, x - tw / 2));
  }

  function node(x, y, label, sub, tone) {
    ctx.beginPath();
    ctx.arc(x, y, 3.4, 0, 6.283);
    ctx.fillStyle = tone;
    ctx.shadowBlur = 10; ctx.shadowColor = tone;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(219,222,206,.82)';
    ctx.font = '600 11px ui-monospace, "SF Mono", Menlo, monospace';
    ctx.fillText(label, centred(label, x), y - 12);
    if (sub) {
      ctx.fillStyle = 'rgba(156,160,142,.7)';
      ctx.font = '400 10px ui-monospace, "SF Mono", Menlo, monospace';
      ctx.fillText(sub, centred(sub, x), y + 20);
    }
  }

  function drawChrome() {
    const b = box();

    // the boundary. dashed, because it is a claim rather than a wall you can see
    ctx.save();
    ctx.setLineDash([5, 5]);
    ctx.strokeStyle = 'rgba(255,255,255,.24)';
    ctx.lineWidth = 1;
    ctx.strokeRect(b.x0 + .5, b.y0 + .5, b.x1 - b.x0, b.y1 - b.y0);
    ctx.restore();

    ctx.font = '400 10px ui-monospace, "SF Mono", Menlo, monospace';
    const tag = 'YOUR MACHINE';
    const tw = ctx.measureText(tag).width;
    ctx.clearRect(b.x0 + 12, b.y0 - 6, tw + 10, 12);
    ctx.fillStyle = 'rgba(156,160,142,.85)';
    ctx.fillText(tag, b.x0 + 17, b.y0 + 4);

    // the crossing, called out only where there is one
    if (hosted) {
      const g = ctx.createLinearGradient(b.x1 - 8, 0, b.x1 + 8, 0);
      g.addColorStop(0, 'rgba(200,122,78,0)');
      g.addColorStop(0.5, 'rgba(200,122,78,.55)');
      g.addColorStop(1, 'rgba(200,122,78,0)');
      ctx.fillStyle = g;
      ctx.fillRect(b.x1 - 8, midY() - h * 0.16, 16, h * 0.32);
    }

    node(srcX(), imapY(), 'IMAP HOST', 'over TLS', 'rgba(176,180,164,.85)');
    node(srcX(), calY(), 'CALENDAR', '.ics / CalDAV', 'rgba(176,180,164,.85)');
    node(indexX(), midY(), 'INDEX', 'on your disk', 'rgba(206,210,192,.9)');
    if (hosted) node(workX(), midY(), 'PROVIDER', 'not yours', HOT);
    else node(workX(), midY(), 'MODEL', '127.0.0.1', COOL);
  }

  /* ── loop ───────────────────────────────────────────────────────────────── */
  let running = false;
  let raf = 0;
  let last = 0;
  let carryIn = 0;
  let carryWork = 0;

  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;

    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = 'rgba(0,0,0,.26)';
    ctx.fillRect(0, 0, w, h);
    drawChrome();

    const rate = Math.min(1.3, w / 420);
    carryIn += dt * 7 * rate;
    while (carryIn >= 1) { parts.push(spawnIn(Math.random() < 0.6 ? 'imap' : 'cal')); carryIn -= 1; }
    carryWork += dt * 4.2 * rate;
    while (carryWork >= 1 && parts.length < 220) { parts.push(spawnWork()); carryWork -= 1; }

    ctx.globalCompositeOperation = 'lighter';
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      if (!step(p, dt)) { parts.splice(i, 1); continue; }
      const q = place(p);
      ctx.shadowBlur = q.glow ? 9 : 0;
      ctx.shadowColor = q.colour;
      ctx.fillStyle = q.colour;
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
    for (let i = 0; i < 40; i++) {
      const p = spawnIn(Math.random() < 0.6 ? 'imap' : 'cal');
      p.t = Math.random(); parts.push(p);
    }
    for (let i = 0; i < 26; i++) {
      const p = spawnWork();
      p.t = Math.random() * 2; parts.push(p);
    }
  }

  function settle() {
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, w, h);
    prime();
    drawChrome();
    for (const p of parts) {
      const q = place(p);
      ctx.fillStyle = q.colour;
      ctx.beginPath();
      ctx.arc(q.x, q.y, p.r, 0, 6.283);
      ctx.fill();
    }
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

  return { start, stop, resize };
}
