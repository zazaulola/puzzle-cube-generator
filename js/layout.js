'use strict';
/* ============================================================
   layout.js — clearance (polygon offset) and packing pieces
   onto printer plates.
   ============================================================ */

// Uniform inward offset of a polygon by delta (mm). Expects CCW input.
function offsetPolygon(poly, delta) {
  if (delta <= 0) return poly;
  const n = poly.length;
  if (signedArea(poly) < 0) poly = [...poly].reverse();
  const out = [];
  for (let i = 0; i < n; i++) {
    const p0 = poly[(i - 1 + n) % n], p1 = poly[i], p2 = poly[(i + 1) % n];
    const n1 = edgeNormal(p0, p1), n2 = edgeNormal(p1, p2);
    let mx = n1[0] + n2[0], my = n1[1] + n2[1];
    const ml = Math.hypot(mx, my);
    if (ml < 1e-9) { out.push([p1[0] - n1[0] * delta, p1[1] - n1[1] * delta]); continue; }
    mx /= ml; my /= ml;
    const cosHalf = mx * n1[0] + my * n1[1];
    const k = delta / Math.max(0.35, cosHalf); // miter limit on sharp corners
    out.push([p1[0] - mx * k, p1[1] - my * k]);
  }
  // drop coincident vertices (collapsed narrow bumps)
  const clean = [];
  for (const p of out) {
    const q = clean[clean.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-6) clean.push(p);
  }
  while (clean.length > 2 && Math.hypot(clean[0][0] - clean[clean.length - 1][0], clean[0][1] - clean[clean.length - 1][1]) < 1e-6) clean.pop();
  return clean.length >= 3 ? clean : out;
}
function edgeNormal(a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
  return [dy / l, -dx / l]; // outward for CCW
}
function signedArea(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}
function polyBBox(poly) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of poly) {
    if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
  }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

// Tilted print orientation: rotate 45° about X, then 45° about Y.
// Both piece sides then print with the same (layered) finish.
const TILT_S = Math.SQRT1_2;
function tilt45(x, y, z) {
  const y1 = (y - z) * TILT_S, z1 = (y + z) * TILT_S; // Rx(45°)
  return [(x + z1) * TILT_S, y1, (z1 - x) * TILT_S];  // Ry(45°)
}

/* Plate layout. Pieces are grouped by color (when 4 colors are used) and
   each group is split across plateCount plates (the scale). Overflow goes
   to extra plates flagged as overflow.
   Returns { plates, overflowCount, misfit } */
function layoutPlates(model, opts) {
  const { colors, plateCount, bedW, bedH } = opts;
  // cap the clearance at a third of a cell — otherwise single-cell bumps collapse
  const clearance = Math.min(opts.clearance, model.c ? 0.3 * model.c : opts.clearance);
  const margin = 8, gap = 3;
  const groups = [];
  if (colors === 4) {
    for (let c = 0; c < 4; c++) groups.push({ color: c, pieces: model.pieces.filter(p => p.color === c) });
  } else {
    groups.push({ color: null, pieces: model.pieces });
  }

  const plates = [];
  let overflowCount = 0;

  const tilt = !!opts.tilt;
  for (const g of groups) {
    // preparation: offset + bbox, stable order (by faces/cells)
    const items = g.pieces.map(p => {
      const poly = offsetPolygon(p.poly, clearance);
      if (!tilt) return { piece: p, poly, bb: polyBBox(poly) };
      // footprint of the tilted piece: both outline rings transformed
      const r0 = poly.map(q => tilt45(q[0], q[1], 0));
      const r1 = poly.map(q => tilt45(q[0], q[1], model.t));
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, zmin = Infinity;
      for (const v of r0.concat(r1)) {
        if (v[0] < x0) x0 = v[0]; if (v[0] > x1) x1 = v[0];
        if (v[1] < y0) y0 = v[1]; if (v[1] > y1) y1 = v[1];
        if (v[2] < zmin) zmin = v[2];
      }
      return { piece: p, poly, r0, r1, zmin, bb: { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 } };
    });
    // split into plateCount roughly equal chunks, preserving order
    const per = Math.ceil(items.length / plateCount);
    const chunks = [];
    for (let i = 0; i < plateCount; i++) chunks.push(items.slice(i * per, (i + 1) * per));
    let pending = [];
    chunks.forEach((chunk, ci) => {
      const rest = packOnePlate(plates, g.color, ci, chunk.concat(pending.splice(0)), bedW, bedH, margin, gap, false);
      pending = rest;
    });
    // Overflow → extra plates. The loop is guaranteed to finish:
    // packOnePlate either places at least one piece, or force-places
    // the remainder on a plate flagged tooBig and returns [].
    let extra = plateCount;
    while (pending.length) {
      overflowCount++;
      pending = packOnePlate(plates, g.color, extra++, pending, bedW, bedH, margin, gap, true);
    }
  }
  const misfit = plates.some(p => p.tooBig);
  return { plates, overflowCount, misfit };
}

// A packed entry: flat pieces carry the translated outline; tilted ones
// carry both transformed rings (for preview) plus the source outline and
// offsets for STL generation.
function placeItem(it, dx, dy) {
  if (!it.r0) {
    return { piece: it.piece, poly: it.poly.map(p => [p[0] + dx, p[1] + dy]) };
  }
  return {
    piece: it.piece,
    poly: it.r0.map(v => [v[0] + dx, v[1] + dy]),
    poly2: it.r1.map(v => [v[0] + dx, v[1] + dy]),
    tilt: { src: it.poly, dx, dy, zmin: it.zmin },
  };
}

// Shelf packing; returns whatever did not fit
function packOnePlate(plates, color, index, items, bedW, bedH, margin, gap, overflow) {
  const sorted = [...items].sort((a, b) => b.bb.h - a.bb.h);
  const placed = [], rest = [];
  let cx = margin, cy = margin, rowH = 0;
  for (const it of sorted) {
    const w = it.bb.w, h = it.bb.h;
    if (w > bedW - 2 * margin) { rest.push(it); continue; }
    // tentative placement — the cursor moves only on success
    let px = cx, py = cy, wrapped = false;
    if (px + w > bedW - margin) { px = margin; py = cy + rowH + gap; wrapped = true; }
    if (py + h > bedH - margin) { rest.push(it); continue; }
    if (wrapped) { cy = py; rowH = 0; }
    placed.push(placeItem(it, px - it.bb.x0, py - it.bb.y0));
    cx = px + w + gap; rowH = Math.max(rowH, h);
  }
  if (placed.length) plates.push({ color, index, pieces: placed, bedW, bedH, overflow });
  else if (items.length) {
    // nothing fits — place by force so the loop cannot spin forever
    plates.push({ color, index, pieces: items.map(it => placeItem(it, 0, 0)), bedW, bedH, overflow: true, tooBig: true });
    return [];
  }
  return rest;
}
