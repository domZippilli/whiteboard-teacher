// Whiteboard renderer: implements the ops in docs/SCRIPT_API.md on an SVG element.
// Every op returns a promise that resolves when its drawing has finished. Animations use the
// Web Animations API (and SMIL for particles) so they can all be paused together.
// `board.onSound(kind, info)` (optional) hears what's being drawn, for the marker sounds, and plays
// the `sound`/`music` ops; nothing is heard when the board is rebuilt instantly.

const NS = 'http://www.w3.org/2000/svg';
export const W = 1600, H = 900;

const COLORS = {
  black: '#22262b', blue: '#1f5fbf', red: '#d23a2f', green: '#2e8a3e', orange: '#e57a12',
  purple: '#7b3fb5', brown: '#8a5a2b', gray: '#7d838b', grey: '#7d838b', teal: '#178a8a',
  pink: '#d84a8f', yellow: '#f2c200', white: '#ffffff',
};
const col = c => (c && COLORS[String(c).toLowerCase()]) || c || COLORS.black;
const FONT = "'Patrick Hand', 'Comic Neue', 'Comic Sans MS', cursive";

function el(tag, attrs = {}, parent) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
}
const num = (v, d) => (Number.isFinite(+v) && v !== null && v !== '' ? +v : d);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export class Board {
  constructor(svg) {
    this.svg = svg;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const defs = el('defs', {}, svg);
    // Subtle marker wobble so clean geometry looks hand-drawn.
    const f = el('filter', { id: 'wobble', x: '-5%', y: '-5%', width: '110%', height: '110%' }, defs);
    el('feTurbulence', { type: 'fractalNoise', baseFrequency: '0.02', numOctaves: '2', seed: '3', result: 'n' }, f);
    el('feDisplacementMap', { in: 'SourceGraphic', in2: 'n', scale: '3', xChannelSelector: 'R', yChannelSelector: 'G' }, f);
    const clip = el('clipPath', { id: 'boardclip' }, defs);
    el('rect', { x: 0, y: 0, width: W, height: H }, clip);
    this.layer = el('g', { 'clip-path': 'url(#boardclip)', filter: 'url(#wobble)' }, svg);
    this.items = new Map(); // id -> { g, kind, ref:[x,y], extra }
    this.groups = new Map(); // group id -> Set of ids
    this.speed = 1;
    this.anon = 0;
    this.paused = false;
    this.tweens = new Set();
    this.onSound = null;
  }
  // Seconds are real time (drawing speed applied).
  emit(kind, info) { try { this.onSound?.(kind, info); } catch (e) { console.warn('sound', e); } }

  // rAF-driven tween for things WAAPI handles poorly (per-letter text). Respects pause and speed.
  tween(dur, frame) {
    if (dur <= 0) { frame(1); return Promise.resolve(); }
    return new Promise(resolve => {
      let t = 0, last = performance.now();
      const tw = { finish: () => { t = dur; } };
      this.tweens.add(tw);
      const tick = now => {
        if (!this.paused) t += ((now - last) / 1000) * this.speed;
        last = now;
        const k = Math.min(1, t / dur);
        frame(k);
        if (k >= 1) { this.tweens.delete(tw); resolve(); } else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }

  // ----- bookkeeping -----

  reset() {
    this.layer.replaceChildren();
    this.items.clear();
    this.groups.clear();
  }

  pause() { this.paused = true; this.svg.pauseAnimations(); this.anims().forEach(a => a.pause()); }
  resume() { this.paused = false; this.svg.unpauseAnimations(); this.anims().forEach(a => a.playState === 'paused' && a.play()); }
  anims() { return this.layer.getAnimations({ subtree: true }); }
  finishAll() {
    this.tweens.forEach(t => t.finish());
    for (const a of this.anims()) {
      try { if (a.effect.getTiming().iterations !== Infinity) a.finish(); } catch {}
    }
  }

  register(id, g, kind, ref, group) {
    id = id || `_${++this.anon}`;
    const old = this.items.get(id);
    if (old) old.g.remove();
    g.dataset.id = id;
    const item = { id, g, kind, ref, tx: 0, ty: 0, s: 1, rot: 0 };
    this.items.set(id, item);
    if (group) this.addToGroup(group, id);
    return item;
  }
  addToGroup(group, id) {
    if (!this.groups.has(group)) this.groups.set(group, new Set());
    this.groups.get(group).add(id);
  }
  // Resolve a target (id, group id, dot-stream prefix, or array) to items.
  resolve(target) {
    if (Array.isArray(target)) return target.flatMap(t => this.resolve(t));
    if (this.items.has(target)) return [this.items.get(target)];
    if (this.groups.has(target)) return [...this.groups.get(target)].flatMap(t => this.resolve(t));
    return [];
  }

  // Bounding box of items in board coordinates (accounts for transforms).
  bbox(items) {
    const m = this.svg.getScreenCTM()?.inverse();
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const it of items) {
      const r = it.g.getBoundingClientRect();
      if (!m || (!r.width && !r.height)) continue;
      const a = new DOMPoint(r.left, r.top).matrixTransform(m);
      const b = new DOMPoint(r.right, r.bottom).matrixTransform(m);
      x1 = Math.min(x1, a.x); y1 = Math.min(y1, a.y); x2 = Math.max(x2, b.x); y2 = Math.max(y2, b.y);
    }
    if (x1 === Infinity) return null;
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1, cx: (x1 + x2) / 2, cy: (y1 + y2) / 2 };
  }

  animate(node, frames, dur, opts = {}) {
    if (dur <= 0) {
      const last = frames[frames.length - 1];
      for (const [k, v] of Object.entries(last)) node.style[k] = v;
      return Promise.resolve();
    }
    const a = node.animate(frames, { duration: (dur * 1000) / this.speed, fill: 'forwards', easing: 'ease-in-out', ...opts });
    return a.finished.then(() => {
      if (opts.iterations === Infinity) return;
      try { a.commitStyles(); a.cancel(); } catch {}
    }, () => {});
  }

  // ----- drawing primitives -----

  // Draw a stroke on (dash animation), then fade in fill, then arrowheads.
  async strokeOn(shape, op, dur, natural) {
    const fill = op.fill && op.fill !== 'none' ? col(op.fill) : 'none';
    shape.setAttribute('fill', fill);
    shape.setAttribute('fill-opacity', '0');
    shape.setAttribute('stroke', col(op.color));
    shape.setAttribute('stroke-width', num(op.width, 4));
    shape.setAttribute('stroke-linecap', 'round');
    shape.setAttribute('stroke-linejoin', 'round');
    let len = 0;
    try { len = shape.getTotalLength(); } catch {}
    const d = dur ?? clamp(len / 900, 0.3, 1.6) * (natural ?? 1);
    const fo = num(op.fillOpacity, 0.25);
    if (len > 0) {
      shape.setAttribute('pathLength', '1');
      const dash = op.dash ? null : '1';
      shape.style.strokeDasharray = '1 1';
      if (d > 0) this.emit('stroke', { dur: d / this.speed, len });
      await this.animate(shape, [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], d, { easing: 'ease-out' });
      shape.removeAttribute('pathLength');
      shape.style.strokeDasharray = op.dash ? `${num(op.width, 4) * 3} ${num(op.width, 4) * 3}` : dash ? '' : '';
      shape.style.strokeDashoffset = '';
    }
    if (fill !== 'none') await this.animate(shape, [{ fillOpacity: 0 }, { fillOpacity: fo }], d > 0 ? 0.35 : 0);
    else shape.setAttribute('fill-opacity', fo);
    if (fill !== 'none' && d <= 0) shape.style.fillOpacity = fo;
    if (op.arrow) await this.arrowheads(shape, op, d > 0 ? 0.15 : 0);
  }

  async arrowheads(shape, op, dur) {
    const which = op.arrow === true ? 'end' : op.arrow;
    const len = shape.getTotalLength();
    if (!len) return;
    const g = shape.parentNode;
    const size = 10 + num(op.width, 4) * 2.5;
    const heads = [];
    const head = (at, back) => {
      const p = shape.getPointAtLength(at);
      const q = shape.getPointAtLength(clamp(back, 0, len));
      const ang = Math.atan2(p.y - q.y, p.x - q.x);
      const a1 = ang + Math.PI * 0.82, a2 = ang - Math.PI * 0.82;
      const h = el('path', {
        d: `M ${p.x + size * Math.cos(a1)} ${p.y + size * Math.sin(a1)} L ${p.x} ${p.y} L ${p.x + size * Math.cos(a2)} ${p.y + size * Math.sin(a2)}`,
        fill: 'none', stroke: col(op.color), 'stroke-width': num(op.width, 4), 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      }, g);
      heads.push(h);
    };
    if (which === 'end' || which === 'both') head(len, len - 6);
    if (which === 'start' || which === 'both') head(0, 6);
    await Promise.all(heads.map(h => this.animate(h, [{ opacity: 0 }, { opacity: 1 }], dur)));
  }

  async writeText(op, dur) {
    const size = num(op.size, 40);
    const g = el('g', {}, this.layer);
    const anchor = { start: 'start', middle: 'middle', end: 'end', center: 'middle', left: 'start', right: 'end' }[op.align] || 'start';
    const t = el('text', {
      x: num(op.x, 0), y: num(op.y, 0), 'font-size': size, 'font-family': FONT, fill: col(op.color),
      'text-anchor': anchor, 'font-weight': op.bold ? 700 : 400,
    }, g);
    const lines = String(op.text ?? '').split('\n');
    const spans = [];
    lines.forEach((line, li) => {
      const row = el('tspan', { x: num(op.x, 0), dy: li ? size * 1.2 : 0 }, t);
      for (const ch of line) {
        const s = el('tspan', {}, row);
        s.textContent = ch;
        s.style.opacity = 0;
        spans.push(s);
      }
    });
    const item = this.register(op.id, g, 'text', [num(op.x, 0), num(op.y, 0)], op.group);
    const total = dur ?? clamp(spans.length * 0.045, 0.2, 3);
    let shown = 0;
    if (total > 0 && spans.length) this.emit('write', { dur: total / this.speed, chars: spans.length });
    await this.tween(total, k => {
      const n = Math.ceil(k * spans.length);
      for (; shown < n; shown++) spans[shown].style.opacity = 1;
    });
    if (op.underline) {
      const b = this.bbox([item]);
      if (b) {
        const u = el('path', { d: `M ${b.x} ${b.y + b.h + 4} Q ${b.cx} ${b.y + b.h + 10} ${b.x + b.w} ${b.y + b.h + 2}` }, g);
        await this.strokeOn(u, { color: op.color, width: Math.max(3, size / 14) }, total > 0 ? 0.3 : 0);
      }
    }
    return item;
  }

  async shape(tag, attrs, op, ref, dur, kind = tag) {
    const g = el('g', {}, this.layer);
    const s = el(tag, attrs, g);
    const item = this.register(op.id, g, kind, ref, op.group);
    await this.strokeOn(s, op, dur);
    return item;
  }

  // ----- transforms -----

  applyTransform(it, dur, opts) {
    const b = it.center || (it.center = this.bbox([it]) || { cx: it.ref[0], cy: it.ref[1] });
    const about = it.about || [b.cx, b.cy];
    it.g.style.transformBox = 'view-box';
    it.g.style.transformOrigin = `${about[0]}px ${about[1]}px`;
    const tf = `translate(${it.tx}px, ${it.ty}px) rotate(${it.rot}deg) scale(${it.s})`;
    const from = it.g.style.transform || getComputedStyle(it.g).transform;
    return this.animate(it.g, [{ transform: from === 'none' ? 'none' : from }, { transform: tf }], dur, opts);
  }

  // ----- op dispatch -----

  // Run an op. `instant` draws without animation (used when rebuilding the board).
  async run(op, instant = false) {
    if (!op || typeof op !== 'object') return;
    const dur = instant ? 0 : op.dur !== undefined ? num(op.dur, undefined) : undefined;
    try {
      const fn = this['op_' + op.op];
      if (fn) await fn.call(this, op, dur, instant);
    } catch (e) {
      console.warn('op failed', op, e);
    }
  }

  async op_clear(op, dur) {
    if (dur === 0 || !this.layer.childNodes.length) return this.reset();
    this.emit('erase', { dur: 0.4 / this.speed });
    await this.animate(this.layer, [{ opacity: 1 }, { opacity: 0 }], 0.4);
    this.reset();
    this.layer.style.opacity = 1;
  }

  op_text(op, dur) { return this.writeText(op, dur); }

  op_line(op, dur) {
    const x1 = num(op.x1, 0), y1 = num(op.y1, 0), x2 = num(op.x2, 0), y2 = num(op.y2, 0);
    return this.shape('path', { d: `M ${x1} ${y1} L ${x2} ${y2}` }, op, [x1, y1], dur, 'line');
  }

  op_rect(op, dur) {
    const x = num(op.x, 0), y = num(op.y, 0), w = num(op.w ?? op.width, 100), h = num(op.h ?? op.height, 100);
    const r = clamp(num(op.r, 0), 0, Math.min(w, h) / 2);
    // As a path so the stroke draws on from the top-left corner.
    const d = r
      ? `M ${x + r} ${y} H ${x + w - r} A ${r} ${r} 0 0 1 ${x + w} ${y + r} V ${y + h - r} A ${r} ${r} 0 0 1 ${x + w - r} ${y + h} H ${x + r} A ${r} ${r} 0 0 1 ${x} ${y + h - r} V ${y + r} A ${r} ${r} 0 0 1 ${x + r} ${y} Z`
      : `M ${x} ${y} H ${x + w} V ${y + h} H ${x} Z`;
    // `width` is the stroke width here, so don't pass op.width through as the rect width above unless w is missing.
    return this.shape('path', { d }, { ...op, width: op.w !== undefined ? op.width : undefined }, [x, y], dur, 'rect');
  }

  op_circle(op, dur) {
    const cx = num(op.cx ?? op.x, 0), cy = num(op.cy ?? op.y, 0), r = num(op.r, 40);
    const d = `M ${cx - r} ${cy} A ${r} ${r} 0 1 1 ${cx + r} ${cy} A ${r} ${r} 0 1 1 ${cx - r} ${cy} Z`;
    return this.shape('path', { d }, op, [cx, cy], dur, 'circle');
  }

  op_ellipse(op, dur) {
    const cx = num(op.cx ?? op.x, 0), cy = num(op.cy ?? op.y, 0), rx = num(op.rx, 80), ry = num(op.ry, 40);
    const d = `M ${cx - rx} ${cy} A ${rx} ${ry} 0 1 1 ${cx + rx} ${cy} A ${rx} ${ry} 0 1 1 ${cx - rx} ${cy} Z`;
    return this.shape('path', { d }, op, [cx, cy], dur, 'ellipse');
  }

  op_path(op, dur) {
    const m = String(op.d || '').match(/-?\d*\.?\d+/g) || [0, 0];
    return this.shape('path', { d: op.d }, op, [+m[0], +m[1]], dur, 'path');
  }

  op_polyline(op, dur) {
    const pts = (op.points || []).map(p => (Array.isArray(p) ? p : [p.x, p.y]));
    if (!pts.length) return;
    let d = `M ${pts[0][0]} ${pts[0][1]}`;
    if (op.smooth && pts.length > 2) {
      // Catmull-Rom to cubic Bézier
      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
        d += ` C ${p1[0] + (p2[0] - p0[0]) / 6} ${p1[1] + (p2[1] - p0[1]) / 6} ${p2[0] - (p3[0] - p1[0]) / 6} ${p2[1] - (p3[1] - p1[1]) / 6} ${p2[0]} ${p2[1]}`;
      }
    } else d += pts.slice(1).map(p => ` L ${p[0]} ${p[1]}`).join('');
    return this.shape('path', { d }, op, pts[0], dur, 'polyline');
  }

  async op_brace(op, dur) {
    const x1 = num(op.x1, 0), y1 = num(op.y1, 0), x2 = num(op.x2, 0), y2 = num(op.y2, 0);
    const horiz = Math.abs(x2 - x1) >= Math.abs(y2 - y1);
    let side = op.side || (horiz ? 'below' : 'right');
    // Normal direction: sign chosen so the brace bulges toward `side`.
    const len = Math.hypot(x2 - x1, y2 - y1) || 1;
    const ux = (x2 - x1) / len, uy = (y2 - y1) / len;
    let nx = -uy, ny = ux;
    const want = { below: [0, 1], above: [0, -1], right: [1, 0], left: [-1, 0] }[side] || [0, 1];
    if (nx * want[0] + ny * want[1] < 0) { nx = -nx; ny = -ny; }
    const q = clamp(len * 0.08, 10, 28);
    const P = (t, k) => [x1 + ux * len * t + nx * q * k, y1 + uy * len * t + ny * q * k];
    const [a, b, c, dd, e, f, g2] = [P(0, 0), P(0, 1), P(0.25, 0.5), P(0.5, 2), P(0.75, 0.5), P(1, 1), P(1, 0)];
    const m = P(0.5, 1);
    const d = `M ${a} Q ${b} ${P(0.12, 0.85)} L ${c} Q ${m} ${dd} Q ${m} ${e} L ${P(0.88, 0.85)} Q ${f} ${g2}`.replace(/,/g, ' ');
    const item = await this.shape('path', { d }, op, a, dur, 'brace');
    if (op.label) {
      const tip = P(0.5, 2);
      const size = num(op.size, 30);
      const pad = 10;
      const tx = tip[0] + nx * pad, ty = tip[1] + ny * pad + (ny > 0.5 ? size * 0.8 : 0);
      const align = Math.abs(nx) > 0.5 ? (nx > 0 ? 'start' : 'end') : 'middle';
      const t = await this.writeText({ text: op.label, x: tx, y: Math.abs(nx) > 0.5 ? ty + size * 0.35 : ty, size, color: op.color, align }, dur);
      item.g.appendChild(t.g);
      this.items.delete(t.id);
    }
    return item;
  }

  async op_label(op, dur) {
    const items = this.resolve(op.target);
    const b = this.bbox(items);
    if (!b) return;
    const size = num(op.size, 32), off = num(op.offset, 16);
    const side = op.side || 'below';
    const pos = {
      below: [b.cx, b.y + b.h + off + size * 0.8, 'middle'],
      above: [b.cx, b.y - off, 'middle'],
      left: [b.x - off, b.cy + size * 0.3, 'end'],
      right: [b.x + b.w + off, b.cy + size * 0.3, 'start'],
    }[side] || [b.cx, b.y + b.h + off + size * 0.8, 'middle'];
    return this.writeText({ ...op, x: pos[0], y: pos[1], align: pos[2], size }, dur);
  }

  // Particles: SMIL animateMotion along a path. Doesn't block the timeline.
  op_dot(op) {
    const count = Math.max(1, Math.round(num(op.count, 1)));
    for (let i = 0; i < count; i++) {
      const id = count > 1 ? `${op.id || 'dot'}-${i}` : op.id;
      const g = el('g', {}, this.layer);
      const mover = el('g', {}, g);
      const r = num(op.r, 10);
      const c = col(op.color || 'red');
      if (op.shape === 'square') el('rect', { x: -r, y: -r, width: 2 * r, height: 2 * r, fill: c }, mover);
      else if (op.shape === 'star') {
        const pts = [...Array(10)].map((_, k) => { const a = (k * Math.PI) / 5 - Math.PI / 2, rr = k % 2 ? r * 0.45 : r * 1.2; return `${rr * Math.cos(a)},${rr * Math.sin(a)}`; });
        el('polygon', { points: pts.join(' '), fill: c }, mover);
      } else el('circle', { r, fill: c }, mover);
      if (op.label) {
        const t = el('text', { y: -r - 4, 'text-anchor': 'middle', 'font-size': Math.max(16, r * 2), 'font-family': FONT, fill: c }, mover);
        t.textContent = op.label;
      }
      let len = 0;
      try { len = el('path', { d: op.path }).getTotalLength(); } catch {}
      const passDur = op.dur !== undefined && op.speed === undefined ? num(op.dur, 2) : len / num(op.speed, 200) || 2;
      const delay = num(op.delay, 0) + i * num(op.spacing, 0.5);
      const am = el('animateMotion', {
        path: op.path, dur: `${passDur / this.speed}s`, begin: 'indefinite', fill: 'freeze', rotate: op.rotate ? 'auto' : undefined,
        repeatCount: op.repeat === true ? 'indefinite' : Number.isFinite(+op.repeat) && +op.repeat > 0 ? +op.repeat : 1,
      }, mover);
      // Hide until it starts moving (it would sit at 0,0 otherwise).
      mover.setAttribute('visibility', 'hidden');
      am.addEventListener('beginEvent', () => mover.removeAttribute('visibility'));
      const item = this.register(id, g, 'dot', [0, 0], op.group);
      if (count > 1 && op.id) this.addToGroup(op.id, id);
      item.motion = am;
      am.beginElementAt(delay / this.speed);
    }
  }

  async op_move(op, dur) {
    const items = this.resolve(op.target);
    const d = dur ?? 1;
    await Promise.all(items.map(it => {
      if (op.to) {
        const [x, y] = op.to;
        it.tx = x - it.ref[0]; it.ty = y - it.ref[1];
      } else { it.tx += num(op.dx, 0); it.ty += num(op.dy, 0); }
      return this.applyTransform(it, d);
    }));
  }

  async op_scale(op, dur) {
    await Promise.all(this.resolve(op.target).map(it => { it.s *= num(op.factor, 1.5); return this.applyTransform(it, dur ?? 0.8); }));
  }

  async op_rotate(op, dur) {
    await Promise.all(this.resolve(op.target).map(it => {
      if (op.about) it.about = op.about;
      if (op.repeat === true) {
        const deg = num(op.deg, 360);
        const base = `translate(${it.tx}px, ${it.ty}px) scale(${it.s})`;
        it.g.style.transformBox = 'view-box';
        const b = this.bbox([it]);
        const about = it.about || [b.cx, b.cy];
        it.g.style.transformOrigin = `${about[0]}px ${about[1]}px`;
        this.animate(it.g, [{ transform: `${base} rotate(${it.rot}deg)` }, { transform: `${base} rotate(${it.rot + deg}deg)` }], dur ?? 2, { iterations: Infinity, easing: 'linear' });
        return;
      }
      it.rot += num(op.deg, 90);
      return this.applyTransform(it, dur ?? 1);
    }));
  }

  async op_highlight(op, dur) {
    const items = this.resolve(op.target);
    const b = this.bbox(items);
    if (!b) return;
    const style = op.style || 'pulse';
    const color = op.color || 'red';
    if (style === 'pulse') {
      if (dur !== 0) this.emit('highlight', {});
      await Promise.all(items.map(it => {
        const o = `${b.cx}px ${b.cy}px`;
        it.g.style.transformBox = 'view-box';
        const prev = it.g.style.transform || '';
        return this.animate(it.g, [
          { transform: prev, transformOrigin: o, filter: 'none' },
          { transform: `${prev} scale(1.08)`, transformOrigin: o, filter: 'drop-shadow(0 0 8px rgba(255,200,0,.9))' },
          { transform: prev, transformOrigin: o, filter: 'none' },
        ], dur ?? 0.8, { fill: 'none' });
      }));
      return;
    }
    const p = 14;
    const d = style === 'underline'
      ? `M ${b.x - 4} ${b.y + b.h + 8} Q ${b.cx} ${b.y + b.h + 14} ${b.x + b.w + 4} ${b.y + b.h + 6}`
      : style === 'box'
        ? `M ${b.x - p} ${b.y - p} H ${b.x + b.w + p} V ${b.y + b.h + p} H ${b.x - p} Z`
        : (() => { const rx = b.w / 2 + p * 1.6, ry = b.h / 2 + p * 1.4; return `M ${b.cx - rx} ${b.cy - 4} A ${rx} ${ry} 0 1 1 ${b.cx - rx + 6} ${b.cy + 10} `; })();
    return this.shape('path', { d }, { ...op, color, width: op.width ?? 4, fill: 'none', id: op.id }, [b.x, b.y], dur, 'mark');
  }

  async op_color(op, dur) {
    for (const it of this.resolve(op.target)) {
      for (const n of it.g.querySelectorAll('path,text,circle,rect,polygon')) {
        if (op.color) {
          if (n.tagName === 'text' || n.getAttribute('stroke') === null) n.setAttribute('fill', col(op.color));
          else n.setAttribute('stroke', col(op.color));
        }
        if (op.fill && n.tagName === 'path') { n.setAttribute('fill', col(op.fill)); n.style.fillOpacity = num(op.fillOpacity, 0.25); }
      }
    }
    if (dur !== 0) await new Promise(r => setTimeout(r, 150));
  }

  async op_fade(op, dur) {
    await Promise.all(this.resolve(op.target).map(it =>
      this.animate(it.g, [{ opacity: getComputedStyle(it.g).opacity }, { opacity: num(op.opacity, 0.25) }], dur ?? 0.6)));
  }

  async op_erase(op, dur) {
    const items = this.resolve(op.target);
    if (items.length && dur !== 0) this.emit('erase', { dur: (dur ?? 0.4) / this.speed });
    await Promise.all(items.map(it => this.animate(it.g, [{ opacity: getComputedStyle(it.g).opacity }, { opacity: 0 }], dur ?? 0.4)));
    for (const it of items) { it.g.remove(); this.items.delete(it.id); }
  }

  op_stop(op) {
    for (const it of this.resolve(op.target)) {
      if (it.motion) {
        const mover = it.motion.parentNode;
        const m = mover.getCTM();
        it.motion.remove();
        if (m) mover.setAttribute('transform', `translate(${m.e} ${m.f})`);
      }
      for (const a of it.g.getAnimations()) if (a.effect.getTiming().iterations === Infinity) { a.commitStyles?.(); a.cancel(); }
    }
  }

  op_group(op) {
    for (const c of op.children || []) this.addToGroup(op.id, c);
  }

  op_pause() {} // timing handled by the player

  // Sound effects and music accents: played by whoever listens (the player), not drawn. They don't
  // hold up the timeline.
  op_sound(op, dur, instant) { if (!instant) this.emit('sound', op); }
  op_music(op, dur, instant) { if (!instant) this.emit('music', op); }

  op_icon(op, dur) {
    const size = num(op.size, 100), x = num(op.x, 0), y = num(op.y, 0);
    const d = ICONS[op.name] || ICONS.question;
    const k = size / 100;
    // Icons are authored in a 100x100 box centered at (50,50).
    const tf = s => s.replace(/(-?\d*\.?\d+) (-?\d*\.?\d+)/g, (_, a, b) => `${x + (a - 50) * k} ${y + (b - 50) * k}`);
    return this.shape('path', { d: tf(d) }, { ...op, width: op.width ?? Math.max(3, 5 * k) }, [x, y], dur, 'icon');
  }
}

// Simple pictograms, 100x100 box. Arcs use "rx ry rot large sweep x y" — arc radii are not
// transformed by the scaler above, so arcs are avoided in favor of cubic curves.
const circ = (cx, cy, r) => {
  const c = r * 0.5523;
  return `M ${cx - r} ${cy} C ${cx - r} ${cy - c} ${cx - c} ${cy - r} ${cx} ${cy - r} C ${cx + c} ${cy - r} ${cx + r} ${cy - c} ${cx + r} ${cy} C ${cx + r} ${cy + c} ${cx + c} ${cy + r} ${cx} ${cy + r} C ${cx - c} ${cy + r} ${cx - r} ${cy + c} ${cx - r} ${cy} Z`;
};
const rays = (cx, cy, r1, r2, n) => [...Array(n)].map((_, i) => {
  const a = (i / n) * Math.PI * 2;
  return `M ${(cx + r1 * Math.cos(a)).toFixed(1)} ${(cy + r1 * Math.sin(a)).toFixed(1)} L ${(cx + r2 * Math.cos(a)).toFixed(1)} ${(cy + r2 * Math.sin(a)).toFixed(1)}`;
}).join(' ');
const ICONS = {
  sun: `${circ(50, 50, 22)} ${rays(50, 50, 30, 45, 10)}`,
  bulb: `M 38 70 C 38 60 25 52 25 38 C 25 22 37 12 50 12 C 63 12 75 22 75 38 C 75 52 62 60 62 70 Z M 40 78 L 60 78 M 42 86 L 58 86 M 46 70 L 46 50 L 54 50 L 54 70`,
  battery: `M 20 30 L 78 30 L 78 70 L 20 70 Z M 78 42 L 86 42 L 86 58 L 78 58 M 30 50 L 42 50 M 36 44 L 36 56 M 56 50 L 68 50`,
  person: `${circ(50, 22, 12)} M 50 34 L 50 66 M 30 46 L 70 46 M 50 66 L 34 92 M 50 66 L 66 92`,
  house: `M 15 50 L 50 18 L 85 50 M 25 42 L 25 88 L 75 88 L 75 42 M 43 88 L 43 66 L 57 66 L 57 88`,
  cloud: `M 25 70 C 10 70 10 50 25 48 C 25 32 45 28 52 40 C 58 26 82 30 78 50 C 92 52 90 70 76 70 Z`,
  atom: `${circ(50, 50, 6)} M 10 50 C 10 30 90 30 90 50 C 90 70 10 70 10 50 M 30 15 C 45 5 85 75 70 85 C 55 95 15 25 30 15 M 70 15 C 85 25 45 95 30 85 C 15 75 55 5 70 15`,
  gear: `${circ(50, 50, 14)} ${circ(50, 50, 30)} ${rays(50, 50, 30, 42, 8)}`,
  magnet: `M 20 20 L 20 55 C 20 95 80 95 80 55 L 80 20 L 62 20 L 62 55 C 62 72 38 72 38 55 L 38 20 Z M 20 34 L 38 34 M 62 34 L 80 34`,
  leaf: `M 15 85 C 15 40 40 15 88 12 C 85 60 60 85 15 85 Z M 15 85 L 65 35`,
  'water-drop': `M 50 10 C 50 10 22 48 22 64 C 22 80 35 90 50 90 C 65 90 78 80 78 64 C 78 48 50 10 50 10 Z`,
  flame: `M 50 90 C 25 90 18 68 28 50 C 34 40 38 30 36 14 C 52 24 60 38 58 50 C 64 46 66 40 66 34 C 80 50 82 90 50 90 Z`,
  question: `M 32 32 C 32 14 68 14 68 32 C 68 46 50 46 50 62 M 50 78 L 50 82`,
  check: `M 18 52 L 40 74 L 84 26`,
  cross: `M 22 22 L 78 78 M 78 22 L 22 78`,
  star: `M 50 10 L 61 38 L 90 40 L 67 58 L 75 88 L 50 71 L 25 88 L 33 58 L 10 40 L 39 38 Z`,
  clock: `${circ(50, 50, 38)} M 50 50 L 50 24 M 50 50 L 68 60`,
  globe: `${circ(50, 50, 38)} M 12 50 L 88 50 M 50 12 C 30 30 30 70 50 88 M 50 12 C 70 30 70 70 50 88 M 18 30 L 82 30 M 18 70 L 82 70`,
  heart: `M 50 85 C 20 62 10 45 10 32 C 10 18 22 10 32 10 C 42 10 48 18 50 24 C 52 18 58 10 68 10 C 78 10 90 18 90 32 C 90 45 80 62 50 85 Z`,
};
