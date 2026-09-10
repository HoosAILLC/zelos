/**
 * flow.js — the winnowing.
 *
 * Everything that arrives enters from the left as a colourless dot. It crosses
 * to the hub, and the hub rules on it. Most of it falls away. The few that
 * survive take the accent colour and sort themselves into the four things Zelos
 * actually hands you.
 *
 * The colour rule is the whole diagram and it is not decoration: **undecided is
 * grey, decided has a colour.** A dot is never coloured before the hub has ruled
 * on it, because "which of these needed me?" is the only question the product
 * answers. Which colour it gets is its lane, and the four lanes run across the
 * spectrum top to bottom, so a glance at the right-hand side reads as sorting
 * rather than as four identical streams. And roughly seven in ten fall away,
 * because throwing most of it out IS the product — if the survivors looked like
 * the majority the picture would be selling the wrong thing.
 *
 * Paced by wall clock, paused off-screen and when hidden, and reduced to one
 * settled frame under prefers-reduced-motion.
 */

const SOURCES = [
  { label: 'Mail', at: 0.30 },
  { label: 'Calendar', at: 0.70 },
];

/*
 * Lane weights. `now` is deliberately starved: the product's hard rule is at
 * most four urgent things, and a diagram showing a fat "urgent" lane would
 * contradict the copy three inches below it.
 */
/*
 * Lane colours, taken off the page's one light rather than off the wheel: the
 * fall runs gold at the top through chartreuse and leaf to a quiet green at the
 * bottom, and the lanes are ordered so that urgency is warm. `now` gets the
 * brightest, most golden band and `soon` the coolest, dimmest one — the sorting
 * is legible before a single label is read.
 *
 * Saturation travels with the hue because these are not a wheel's worth of
 * colours: a green at the saturation the gold wants is a highlighter, so each
 * lane carries its own. The jitter is ±8° rather than the ±16° the rainbow
 * used — four bands inside a 46° span would otherwise run into each other, and
 * the point of the jitter is a band with width, not four bands that overlap.
 */
const LANES = [
  { key: 'now', label: 'Now', at: 0.12, weight: 0.04, hue: 48, sat: 72 },
  { key: 'today', label: 'Today', at: 0.34, weight: 0.09, hue: 62, sat: 58 },
  { key: 'owed', label: 'Owed', at: 0.56, weight: 0.08, hue: 78, sat: 46 },
  { key: 'soon', label: 'Soon', at: 0.78, weight: 0.10, hue: 94, sat: 34 },
];
for (const l of LANES) l.colour = `hsl(${l.hue} ${l.sat}% 70%)`;   // the label
const JITTER = 8;
const SURVIVES = LANES.reduce((s, l) => s + l.weight, 0);   // ≈ 0.31

export function createFlow(canvas, { density = 1 } = {}) {
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return null;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let w = 0;
  let h = 0;
  let dpr = 1;

  function resize() {
    const r = canvas.getBoundingClientRect();
    dpr = Math.min(devicePixelRatio || 1, 2);
    w = Math.max(320, Math.round(r.width));
    h = Math.max(200, Math.round(r.height));
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  const hubX = () => w * 0.46;
  const inX = () => w * 0.055;
  /* Lanes end well short of the right edge so their labels have somewhere to
     live. At 0.93 the dots arrived on top of the text. */
  const outX = () => w * 0.845;

  const particles = [];
  /* Roughly one arrival every 55ms at full width, scaled by area so a phone
     does not get the same particle count as a desktop and drop frames. */
  const target = () => Math.round(46 * density * Math.min(1.35, w / 900));

  function spawn() {
    const src = SOURCES[(Math.random() * SOURCES.length) | 0];
    const roll = Math.random();
    let lane = null;
    if (roll < SURVIVES) {
      let acc = 0;
      for (const l of LANES) {
        acc += l.weight;
        if (roll < acc) { lane = l; break; }
      }
    }
    /* Two colours, resolved once at spawn rather than per frame: the hue this
       particular dot ended up with, and a near-white version of it for the
       moment just after the gate. A survivor leaves the hub almost white and
       settles into its colour as it travels — the decision arriving, not a
       colour that was always there. */
    const hue = lane ? lane.hue + (Math.random() - 0.5) * 2 * JITTER : 0;
    return {
      t: 0,
      colour: lane ? `hsl(${hue} ${lane.sat}% 64%)` : null,
      hot: lane ? `hsl(${hue} ${Math.round(lane.sat * 0.75)}% 90%)` : null,
      /* Units of t per second, and t runs 0→2 across the whole journey. At the
         original 0.16–0.27 a dot took 7–12s end to end, which meant the diagram
         was still nearly empty several seconds after you scrolled to it — the
         mechanism has to be legible in the first glance, not the first minute. */
      speed: 0.34 + Math.random() * 0.22,
      y0: h * src.at + (Math.random() - 0.5) * h * 0.16,
      lane,                       // null = will be dropped
      wob: (Math.random() - 0.5) * h * 0.06,
      drop: 0,                    // fall distance once discarded
      // Per-particle sideways drift, or the discarded pile falls as one column
      // and reads like a single object rather than "most of this goes away".
      spread: (Math.random() - 0.5) * 2,
      r: 1.35 + Math.random() * 1.15,
      seed: Math.random() * 6.28,
    };
  }

  function laneY(l) { return h * (0.16 + l.at * 0.68); }

  function step(p, dt) {
    p.t += p.speed * dt;
    if (p.t >= 1 && p.lane === null) p.drop += dt * (0.35 + p.r * 0.1);
    return p.t < 1 || (p.lane ? p.t < 2 : p.drop < 1.1);
  }

  function place(p) {
    if (p.t <= 1) {
      // source -> hub, with a lazy sine so the streams read as flow not rails
      const e = p.t * p.t * (3 - 2 * p.t);
      return {
        x: inX() + (hubX() - inX()) * e,
        y: p.y0 + Math.sin(p.t * 3.1 + p.seed) * p.wob * (1 - p.t) + (h / 2 - p.y0) * e * 0.55,
        decided: false,
      };
    }
    if (p.lane) {
      const u = Math.min(1, p.t - 1);
      const e = u * u * (3 - 2 * u);
      const hy = h / 2 + (p.y0 - h / 2) * 0.45 * (1 - e);
      return {
        x: hubX() + (outX() - hubX()) * e,
        y: hy + (laneY(p.lane) - hy) * e,
        decided: true,
        colour: u < 0.18 ? p.hot : p.colour,
      };
    }
    // discarded: falls out of the frame, fading and fanning out
    return {
      x: hubX() + p.drop * w * 0.035 + p.spread * p.drop * w * 0.11,
      y: h / 2 + (p.y0 - h / 2) * 0.45 + p.drop * p.drop * h * 0.85,
      decided: false,
      dropped: true,
    };
  }

  function drawChrome() {
    ctx.save();
    ctx.font = '500 11px ui-monospace, "SF Mono", Menlo, monospace';
    ctx.textBaseline = 'middle';

    // Sources. Set well clear of their own stream — at -16 the label sat inside
    // the dots and both became unreadable.
    ctx.fillStyle = 'rgba(206,210,192,.62)';
    ctx.textAlign = 'left';
    for (const s of SOURCES) ctx.fillText(s.label.toUpperCase(), inX() - 4, h * s.at - 34);

    // the hub — a soft vertical gate, not a box
    const g = ctx.createLinearGradient(0, h * 0.12, 0, h * 0.88);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.5, 'rgba(255,255,255,.20)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(hubX() - 0.5, h * 0.12, 1, h * 0.76);

    ctx.fillStyle = 'rgba(206,210,192,.5)';
    ctx.textAlign = 'center';
    ctx.fillText('ZELOS', hubX(), h * 0.075);

    // Lanes, left-aligned past the end of the run so nothing lands on the text,
    // each label in its own lane's colour so the sorting is legible from the
    // labels alone rather than only from where the dots land.
    ctx.textAlign = 'left';
    for (const l of LANES) {
      ctx.fillStyle = l.colour;
      ctx.globalAlpha = 0.85;
      ctx.fillText(l.label.toUpperCase(), outX() + 18, laneY(l));
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  let running = false;
  let raf = 0;
  let last = 0;
  let carry = 0;

  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;

    /* Trails: wash the canvas instead of clearing it. clearRect gives hard dots
       with no sense of travel; a translucent black fill leaves a tail that says
       "this moved". */
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = 'rgba(0,0,0,.30)';
    ctx.fillRect(0, 0, w, h);

    drawChrome();

    carry += dt * target() * 1.25;
    while (carry >= 1 && particles.length < target() * 3) { particles.push(spawn()); carry -= 1; }

    ctx.globalCompositeOperation = 'lighter';
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      if (!step(p, dt)) { particles.splice(i, 1); continue; }
      const q = place(p);

      if (q.decided) {
        // Survivors only: shadowBlur is the expensive call, so it is spent on
        // the ~31% that earned it rather than on every dot.
        ctx.shadowBlur = 10;
        ctx.shadowColor = q.colour;
        ctx.fillStyle = q.colour;
      } else if (q.dropped) {
        ctx.shadowBlur = 0;
        ctx.fillStyle = `rgba(156,160,142,${Math.max(0, 0.5 - p.drop * 0.5)})`;
      } else {
        ctx.shadowBlur = 0;
        ctx.fillStyle = 'rgba(176,180,164,.62)';
      }

      ctx.beginPath();
      ctx.arc(q.x, q.y, p.r, 0, 6.283);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
    ctx.globalCompositeOperation = 'source-over';

    if (running) raf = requestAnimationFrame(frame);
  }

  function settle() {
    // One honest still frame: run the simulation forward without painting, then
    // paint once. Reduced motion must not mean an empty rectangle.
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    /* A fresh cast every time. This runs again on every resize, every return to
       the viewport and every tab switch — start() returns before `running` is
       ever set under reduced motion, so nothing else stops it — and without the
       reset each call stacked another 260 on the last (measured 260 → 520 → …
       → 1300), until the one honest frame was a smear. */
    particles.length = 0;
    for (let i = 0; i < 260; i++) particles.push(spawn());
    for (const p of particles) { p.t = Math.random() * 1.9; if (p.t > 1 && !p.lane) p.drop = Math.random() * 0.9; }
    drawChrome();
    for (const p of particles) {
      const q = place(p);
      ctx.fillStyle = q.decided ? q.colour
        : q.dropped ? 'rgba(156,160,142,.28)' : 'rgba(176,180,164,.55)';
      ctx.beginPath();
      ctx.arc(q.x, q.y, p.r, 0, 6.283);
      ctx.fill();
    }
  }

  /* Start mid-flight. The observer starts this when it scrolls into view and the
     viewer looks immediately — an empty frame that fills over the next four
     seconds reads as broken, not as "loading". */
  function prime() {
    if (particles.length) return;
    for (let i = 0; i < Math.round(target() * 1.8); i++) {
      const p = spawn();
      p.t = Math.random() * 1.95;
      if (p.t > 1 && !p.lane) p.drop = Math.random() * 1.0;
      particles.push(p);
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
