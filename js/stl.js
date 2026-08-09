'use strict';
/* ============================================================
   stl.js — 3D piece meshes (voxel caps, walls with hidden
   hemisphere fixators), binary STL, ZIP (store)
   ============================================================ */

const FIX_SEG = 12; // segments of the fixator ring
const FIX_LAT = 3;  // latitude rows of the hemisphere

/* Per-vertex miter offset of a polygon (inward by delta, CCW input).
   Unlike offsetPolygon, keeps the vertex count/order — the mesh needs
   a 1:1 mapping between original and displaced boundary vertices. */
function offsetVerts(poly, delta) {
  const n = poly.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const p0 = poly[(i - 1 + n) % n], p1 = poly[i], p2 = poly[(i + 1) % n];
    const n1 = edgeNormal(p0, p1), n2 = edgeNormal(p1, p2);
    let mx = n1[0] + n2[0], my = n1[1] + n2[1];
    const ml = Math.hypot(mx, my);
    if (ml < 1e-9) { out[i] = [p1[0] - n1[0] * delta, p1[1] - n1[1] * delta]; continue; }
    mx /= ml; my /= ml;
    const cosHalf = mx * n1[0] + my * n1[1];
    const k = delta / Math.max(0.35, cosHalf);
    out[i] = [p1[0] - mx * k, p1[1] - my * k];
  }
  return out;
}

/* Mesh of one piece.
   piece: { outline (unit ints, CCW), cells (unit ints), feats: Map<edgeIdx,'bump'|'socket'> }
   c — cell size (mm), t — thickness (mm), clearance — inward offset (mm),
   emit(9 numbers) — triangle sink (world transform applied by the caller). */
function buildPieceMesh(piece, c, t, clearance, emit) {
  const unit = piece.outline;
  const mm = unit.map(p => [p[0] * c, p[1] * c]);
  const disp = clearance > 0 ? offsetVerts(mm, clearance) : mm;
  const bmap = new Map();
  unit.forEach((p, k) => bmap.set(p[0] + ',' + p[1], disp[k]));
  const P = (i, j) => bmap.get(i + ',' + j) || [i * c, j * c];

  // caps: two triangles per cell, top and bottom
  for (const [i, j] of piece.cells) {
    const a = P(i, j), b = P(i + 1, j), d = P(i + 1, j + 1), e = P(i, j + 1);
    emit(a[0], a[1], t, b[0], b[1], t, d[0], d[1], t);
    emit(a[0], a[1], t, d[0], d[1], t, e[0], e[1], t);
    emit(a[0], a[1], 0, d[0], d[1], 0, b[0], b[1], 0);
    emit(a[0], a[1], 0, e[0], e[1], 0, d[0], d[1], 0);
  }

  // walls per unit outline edge
  const n = unit.length;
  const r = FIX_R * c;
  for (let k = 0; k < n; k++) {
    const A = disp[k], B = disp[(k + 1) % n];
    const feat = piece.feats ? piece.feats.get(k) : undefined;
    if (!feat) {
      emit(A[0], A[1], 0, B[0], B[1], 0, B[0], B[1], t);
      emit(A[0], A[1], 0, B[0], B[1], t, A[0], A[1], t);
    } else {
      wallWithFixator(A, B, t, r, feat === 'bump' ? 1 : -1, emit);
    }
  }
}

/* Wall rectangle A→B (0..t vertical) with a hemisphere of radius r at its
   center: dir=+1 — bump (outward), dir=−1 — socket (carved inward).
   Local wall frame: u along the edge, w vertical, nrm outward (CCW).
   The rect boundary keeps ONLY its 4 corners (no extra edge vertices),
   so caps and neighboring walls mate without T-vertices. The same
   triangle order serves bump and socket: mirroring the heights makes
   the normals come out right, and the ring edges stay paired with the
   annulus. Textured pieces pass extraPts — exact 3D boundary points
   (sub-resolution marks) that neighboring mesh elements share. */
function wallWithFixator(A, B, t, r, dir, emit, extraPts) {
  const ex = B[0] - A[0], ey = B[1] - A[1];
  const el = Math.hypot(ex, ey);
  const ux = ex / el, uy = ey / el;
  const nx = uy, ny = -ux; // outward for CCW
  const C = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2, t / 2];
  // local (a,b) → world; h — offset along the outward normal
  const p3 = (a, b, h) => [C[0] + ux * a + nx * h, C[1] + uy * a + ny * h, C[2] + b];
  const tri = (a, b, cc) => emit(a[0], a[1], a[2], b[0], b[1], b[2], cc[0], cc[1], cc[2]);
  const K = FIX_SEG;

  // The sphere is sunk into the wall: only a cap of height r·(1−FIX_SINK)
  // protrudes. The wall ring sits where the sphere crosses the wall plane.
  const e = FIX_SINK * r;              // center offset behind the wall
  const rho = r * Math.sqrt(1 - FIX_SINK * FIX_SINK); // ring radius on the wall
  const ph0 = Math.asin(FIX_SINK);     // latitude of the wall ring

  // annulus: stitch the 4-corner boundary loop to the K-point ring loop
  const angAt = k => (2 * Math.PI * k) / K; // corners sit near odd 45° — no collisions
  const ring = [];
  for (let k = 0; k < K; k++) ring.push({ ang: angAt(k), pt: p3(rho * Math.cos(angAt(k)), rho * Math.sin(angAt(k)), 0), isR: true });
  // corner vertices reuse the EXACT endpoint coordinates shared with the
  // caps and neighboring walls — recomputing them via the midpoint would
  // differ in the last float bits and break vertex identity
  const cornerPts = { '1,1': [B[0], B[1], t], '-1,1': [A[0], A[1], t], '-1,-1': [A[0], A[1], 0], '1,-1': [B[0], B[1], 0] };
  const corners = [[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([sa, sb]) => {
    const th = (Math.atan2(sb * t / 2, sa * el / 2) + 2 * Math.PI) % (2 * Math.PI);
    return { ang: th, pt: cornerPts[sa + ',' + sb], isR: false };
  });
  const extra = (extraPts || []).map(pt => {
    const a = (pt[0] - C[0]) * ux + (pt[1] - C[1]) * uy;
    const b = pt[2] - t / 2;
    return { ang: (Math.atan2(b, a) + 2 * Math.PI) % (2 * Math.PI), pt, isR: false };
  });
  const events = ring.concat(corners, extra).sort((a, b) => a.ang - b.ang);
  let lastR = null, lastB = null;
  for (let q = events.length - 1; q >= 0 && (!lastR || !lastB); q--) {
    if (events[q].isR && !lastR) lastR = events[q].pt;
    if (!events[q].isR && !lastB) lastB = events[q].pt;
  }
  for (const e of events) {
    tri(lastB, e.pt, lastR);
    if (e.isR) lastR = e.pt; else lastB = e.pt;
  }

  // spherical cap: rows from the wall ring up to the apex (heights signed
  // by dir); row 0 reuses the exact annulus ring vertices
  let prev = ring.map(rp => rp.pt);
  for (let m2 = 1; m2 <= FIX_LAT; m2++) {
    const ph = ph0 + (m2 / FIX_LAT) * (Math.PI / 2 - ph0);
    const rr = r * Math.cos(ph), hh = dir * (r * Math.sin(ph) - e);
    if (m2 === FIX_LAT) {
      const apex = p3(0, 0, dir * (r - e));
      for (let k = 0; k < K; k++) tri(prev[k], prev[(k + 1) % K], apex);
    } else {
      const row = [];
      for (let k = 0; k < K; k++) row.push(p3(rr * Math.cos(angAt(k)), rr * Math.sin(angAt(k)), hh));
      for (let k = 0; k < K; k++) {
        const a = prev[k], b = prev[(k + 1) % K];
        const a2 = row[k], b2 = row[(k + 1) % K];
        tri(a, b, b2); tri(a, b2, a2);
      }
      prev = row;
    }
  }
}

/* ---------- Textured pieces: sub-resolution relief mesh ----------
   The outer surface becomes a heightfield over TEXT_SUB subpixels per
   cell: 0 (plain), +dep (engraved pocket) or −dep (embossed letter).
   The solid is three voxel layers — C [−dep,0] (letters), A [0,dep]
   (skin minus pockets), B [dep,t] (body) — meshed as boundary faces on
   a shared lattice, so everything pairs exactly. Fixator walls keep
   their disk stitch, with sub-resolution marks added to the boundary.
   The lattice is built with the relief around z≈0, then mirrored
   z→t−z at emit time (winding flipped): the relief must sit on the
   z=t side, because z=t is the face the viewer sees — the mask reads
   correctly from +z, and a mirror is the only way to change which side
   the text is legible from (no print-bed rotation can fix chirality).
   With the relief up, the assembled cube matches the net preview
   exactly, and in flat mode both text styles print letters-up. */
function buildTexturedPieceMesh(piece, model, c, t, clearance, emitRaw) {
  // z-mirror about the slab + winding flip; identical input floats give
  // identical outputs, so bit-exact vertex sharing survives the mirror
  const emit = (ax, ay, az, bx, by, bz, gx, gy, gz) =>
    emitRaw(ax, ay, t - az, gx, gy, t - gz, bx, by, t - bz);
  const SUB = model.SUB || TEXT_SUB, ss = c / SUB, dep = TEXT_DEP * c;
  const cfg = model.textMasks[piece.face];
  const NS = model.N * SUB;
  const eng = cfg.style !== 'emb';
  const cellSet = new Set(piece.cells.map(p => p[0] + ',' + p[1]));
  const inPiece = (sx, sy) => sx >= 0 && sy >= 0 &&
    cellSet.has(((sx / SUB) | 0) + ',' + ((sy / SUB) | 0));
  const txt = (sx, sy) => sx >= 0 && sy >= 0 && sx < NS && sy < NS &&
    inPiece(sx, sy) && cfg.data[sy * NS + sx] === 1;
  // layers, relief side first (mirrored to z=t — the outer surface — at emit)
  const layers = [
    { z0: -dep, z1: 0, has: (x, y) => !eng && txt(x, y) },
    { z0: 0, z1: dep, has: (x, y) => inPiece(x, y) && !(eng && txt(x, y)) },
    { z0: dep, z1: t, has: (x, y) => inPiece(x, y) },
  ];

  // displaced boundary sub-vertices (bit-exact shared positions)
  const unit = piece.outline;
  const mm = unit.map(p => [p[0] * c, p[1] * c]);
  const disp = clearance > 0 ? offsetVerts(mm, clearance) : mm;
  const bpos = new Map();
  const nOut = unit.length;
  for (let k = 0; k < nOut; k++) {
    const P0 = unit[k], P1 = unit[(k + 1) % nOut];
    const D0 = disp[k], D1 = disp[(k + 1) % nOut];
    for (let q = 0; q <= SUB; q++) {
      const f = q / SUB;
      const gx = P0[0] * SUB + (P1[0] - P0[0]) * q;
      const gy = P0[1] * SUB + (P1[1] - P0[1]) * q;
      bpos.set(gx + ',' + gy, [D0[0] + (D1[0] - D0[0]) * f, D0[1] + (D1[1] - D0[1]) * f]);
    }
  }
  const P = (gx, gy) => bpos.get(gx + ',' + gy) || [gx * ss, gy * ss];
  const tri = (a, b, cc) => emit(a[0], a[1], a[2], b[0], b[1], b[2], cc[0], cc[1], cc[2]);
  const quadH = (sx, sy, z, up) => {
    const a = P(sx, sy), b = P(sx + 1, sy), d = P(sx + 1, sy + 1), e = P(sx, sy + 1);
    if (up) { tri([a[0], a[1], z], [b[0], b[1], z], [d[0], d[1], z]); tri([a[0], a[1], z], [d[0], d[1], z], [e[0], e[1], z]); }
    else { tri([a[0], a[1], z], [d[0], d[1], z], [b[0], b[1], z]); tri([a[0], a[1], z], [e[0], e[1], z], [d[0], d[1], z]); }
  };
  // lateral wall on the sub-edge G0→G1 (CCW around the present subcell)
  const quadW = (G0, G1, z0, z1) => {
    const a = P(G0[0], G0[1]), b = P(G1[0], G1[1]);
    tri([a[0], a[1], z0], [b[0], b[1], z0], [b[0], b[1], z1]);
    tri([a[0], a[1], z0], [b[0], b[1], z1], [a[0], a[1], z1]);
  };

  // sub-edges covered by fixator walls (their layers A+B are stitched)
  const fixEdges = new Set();
  const fixUnit = [];
  if (piece.feats) {
    for (const [k, type] of piece.feats) {
      fixUnit.push({ k, type });
      const P0 = unit[k], P1 = unit[(k + 1) % nOut];
      for (let q = 0; q < SUB; q++) {
        const g0 = [P0[0] * SUB + (P1[0] - P0[0]) * q, P0[1] * SUB + (P1[1] - P0[1]) * q];
        const g1 = [P0[0] * SUB + (P1[0] - P0[0]) * (q + 1), P0[1] * SUB + (P1[1] - P0[1]) * (q + 1)];
        const key = g0[0] < g1[0] || (g0[0] === g1[0] && g0[1] < g1[1])
          ? g0.join(',') + '|' + g1.join(',') : g1.join(',') + '|' + g0.join(',');
        fixEdges.add(key);
      }
    }
  }
  const onFixWall = (G0, G1) => {
    const key = G0[0] < G1[0] || (G0[0] === G1[0] && G0[1] < G1[1])
      ? G0.join(',') + '|' + G1.join(',') : G1.join(',') + '|' + G0.join(',');
    return fixEdges.has(key);
  };

  // bounding box of the piece in subcells
  let cx0 = Infinity, cy0 = Infinity, cx1 = -Infinity, cy1 = -Infinity;
  for (const [ci, cj] of piece.cells) {
    cx0 = Math.min(cx0, ci); cy0 = Math.min(cy0, cj);
    cx1 = Math.max(cx1, ci); cy1 = Math.max(cy1, cj);
  }
  for (let sy = cy0 * SUB; sy < (cy1 + 1) * SUB; sy++) {
    for (let sx = cx0 * SUB; sx < (cx1 + 1) * SUB; sx++) {
      for (let li = 0; li < 3; li++) {
        const L = layers[li];
        if (!L.has(sx, sy)) continue;
        // horizontal faces
        const below = li > 0 ? layers[li - 1] : null;
        if (!below || !below.has(sx, sy)) quadH(sx, sy, L.z0, false);
        const above = li < 2 ? layers[li + 1] : null;
        if (!above) quadH(sx, sy, L.z1, true);
        else if (!above.has(sx, sy)) quadH(sx, sy, L.z1, true);
        // lateral faces, CCW edge per direction (matches traceOutline)
        const sides = [
          [sx + 1, sy, [sx + 1, sy], [sx + 1, sy + 1]],     // +x
          [sx - 1, sy, [sx, sy + 1], [sx, sy]],             // −x
          [sx, sy + 1, [sx + 1, sy + 1], [sx, sy + 1]],     // +y
          [sx, sy - 1, [sx, sy], [sx + 1, sy]],             // −y
        ];
        for (const [nx, ny, G0, G1] of sides) {
          if (L.has(nx, ny)) continue;
          if (L.z0 >= 0 && onFixWall(G0, G1)) continue; // A+B covered by the disk wall
          quadW(G0, G1, L.z0, L.z1);
        }
      }
    }
  }

  // fixator walls with sub-resolution boundary marks
  const r = FIX_R * c;
  for (const { k, type } of fixUnit) {
    const A = disp[k], B = disp[(k + 1) % nOut];
    const P0 = unit[k], P1 = unit[(k + 1) % nOut];
    const marks = [];
    for (let q = 1; q < SUB; q++) {
      const gx = P0[0] * SUB + (P1[0] - P0[0]) * q;
      const gy = P0[1] * SUB + (P1[1] - P0[1]) * q;
      const p2 = P(gx, gy);
      marks.push([p2[0], p2[1], 0], [p2[0], p2[1], t]);
    }
    marks.push([A[0], A[1], dep], [B[0], B[1], dep]); // side cuts of layer A|B
    wallWithFixator(A, B, t, r, type === 'bump' ? 1 : -1, emit, marks);
  }
}

/* ---------- Hint cube: a small solid color guide ----------
   A much smaller solid cube whose faces show the 4-color scheme of the
   puzzle as a mosaic of the NOMINAL 8×4 elements — plain 1×2 rectangles,
   no real tooth shapes, so it spoils colors but not the cutting.

   STL carries no colors, so (exactly like the puzzle plates) the guide
   is split into one STL per filament: a core body plus four tile sets.
   All five files share one coordinate space — imported together into the
   slicer as a single multi-part object, each part gets its filament.
   The core is a closed solid, so the slicer gives it regular infill.

   Partition of the cube [0,H]³ (no two bodies ever overlap):
   - each face carries a pocket [f, H−f]² of depth s on its surface,
     filled exactly by the color tiles (flush with the surface);
   - the core is the rest: the inner block plus a frame of width f
     around every face and along the cube edges (frame cuboids of the
     same body may overlap each other — slicers union shells per part).
   s ≤ f keeps neighboring faces' pockets clear of each other. */
const HINT_SHELL = 0.8; // tile depth, mm
const HINT_FRAME = 1.2; // frame width around each face mosaic, mm

// Closed axis-aligned box, CCW from outside (12 triangles)
function emitBox(coords, x0, y0, z0, x1, y1, z1) {
  const q = (a, b, c2, d2) => coords.push(...a, ...b, ...c2, ...a, ...c2, ...d2);
  q([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]); // −x
  q([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]); // +x
  q([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]); // −y
  q([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]); // +y
  q([x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]); // −z
  q([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]); // +z
}

// Nominal 1×2 rect of a piece in face quads (quad = 4 cells; face = Q×Q
// quads, Q = 2d). Decoded from piece.id = "Face-I-J-half" plus the same
// checkerboard phase table the cutting itself was built from.
function hintRect(piece, d, PHI, faceIdx) {
  const seg = piece.id.split('-');
  const I = +seg[1], J = +seg[2], half = +seg[3];
  const horiz = (I + J + PHI[faceIdx[piece.face]]) % 2 === 0;
  return horiz
    ? { qu0: 2 * I, qu1: 2 * I + 2, qv0: 2 * J + half, qv1: 2 * J + half + 1 }
    : { qu0: 2 * I + half, qu1: 2 * I + half + 1, qv0: 2 * J, qv1: 2 * J + 2 };
}

// Face-local mm rect (u,v ∈ [uu0,uu1]×[vv0,vv1], inward depth w ∈ [w0,w1])
// → world axis-aligned box via the FACE_DEFS frame (all axes are ±unit).
function faceBox(coords, fd, H, uu0, vv0, uu1, vv1, w0, w1) {
  const W = [
    fd.U[1] * fd.V[2] - fd.U[2] * fd.V[1],
    fd.U[2] * fd.V[0] - fd.U[0] * fd.V[2],
    fd.U[0] * fd.V[1] - fd.U[1] * fd.V[0],
  ];
  const pt = (u, v, w) => [0, 1, 2].map(k => fd.O[k] * H + u * fd.U[k] + v * fd.V[k] - w * W[k]);
  const a = pt(uu0, vv0, w1), b = pt(uu1, vv1, w0);
  emitBox(coords,
    Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2]),
    Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2]));
}

// The five bodies as raw triangle soups: [{color: 0..3, coords}, ...,
// {color: null, coords}] (core last) — shared by the STL and 3MF exports
function hintBodies(model, H) {
  const d = model.difficulty;
  const PHI = solveFacePhases(d);
  const faceIdx = Object.fromEntries(FACE_DEFS.map((fd, k) => [fd.name, k]));
  const byFace = Object.fromEntries(FACE_DEFS.map(fd => [fd.name, fd]));
  const s = HINT_SHELL, f = HINT_FRAME;
  const Q = 2 * d, q = (H - 2 * f) / Q;

  const bodies = [[], [], [], []];
  for (const p of model.pieces) {
    const r = hintRect(p, d, PHI, faceIdx);
    faceBox(bodies[p.color], byFace[p.face], H,
      f + r.qu0 * q, f + r.qv0 * q, f + r.qu1 * q, f + r.qv1 * q, 0, s);
  }

  const core = [];
  emitBox(core, s, s, s, H - s, H - s, H - s); // inner block
  for (const fd of FACE_DEFS) {
    // frame ring of the face slab (the pocket itself belongs to the tiles)
    faceBox(core, fd, H, 0, 0, H, f, 0, s);         // v-low strip
    faceBox(core, fd, H, 0, H - f, H, H, 0, s);     // v-high strip
    faceBox(core, fd, H, 0, f, f, H - f, 0, s);     // u-low strip
    faceBox(core, fd, H, H - f, f, H, H - f, 0, s); // u-high strip
  }

  const out = bodies.map((coords, k) => ({ color: k, coords }));
  out.push({ color: null, coords: core });
  return out;
}

// The five bodies as binary STLs: [{color, buf}] (core last)
function hintSTLs(model, H) {
  return hintBodies(model, H).map(b => ({ color: b.color, buf: buildSTL(b.coords) }));
}

/* Single-file 3MF export of the hint cube. 3MF is a zip of XML: the core
   spec carries all five meshes as objects assembled into one build item,
   with basematerials giving each part its display color (the user's own
   palette). On top of that, Metadata/model_settings.config — the config
   file Bambu Studio / Orca read — declares the five meshes as PARTS of
   one object with a filament ("extruder") preassigned per part: colors
   1–4 map to AMS slots 1–4, the core defaults to slot 1. Slicers that
   ignore the config still open five correctly placed colored objects. */
function hint3MF(model, H, palette) {
  const parts = hintBodies(model, H);
  const fmt = v => String(+v.toFixed(6));
  // deterministic, but shaped as RFC 4122 version-4/variant-1
  const uuid = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
  const CORE_COLOR = '#9e9e9e';
  const names = parts.map(p => (p.color === null ? 'core' : 'color-' + (p.color + 1)));

  let res = '';
  parts.forEach((part, k) => {
    const verts = [];
    let tris = '';
    const c = part.coords;
    for (let b = 0; b < c.length; b += 108) { // 12 triangles per box
      /* vertex welding is scoped PER BOX: each cuboid stays its own closed
         shell with exactly-two-triangles-per-edge, satisfying the core
         spec's manifold-edge rule — welding across touching boxes would
         create edges shared by four triangles */
      const vmap = new Map();
      const idxOf = o => {
        const key = fmt(c[o]) + '|' + fmt(c[o + 1]) + '|' + fmt(c[o + 2]);
        let idx = vmap.get(key);
        if (idx === undefined) { idx = verts.length; verts.push(key); vmap.set(key, idx); }
        return idx;
      };
      for (let o = b; o < Math.min(b + 108, c.length); o += 9) {
        tris += `<triangle v1="${idxOf(o)}" v2="${idxOf(o + 3)}" v3="${idxOf(o + 6)}"/>`;
      }
    }
    res += `<object id="${k + 1}" p:UUID="${uuid(k + 1)}" type="model" pid="9" pindex="${k}"><mesh><vertices>`;
    res += verts.map(v => {
      const [x, y, z] = v.split('|');
      return `<vertex x="${x}" y="${y}" z="${z}"/>`;
    }).join('');
    res += `</vertices><triangles>${tris}</triangles></mesh></object>`;
  });

  const mats = parts.map((p, k) =>
    `<base name="${names[k]}" displaycolor="${p.color === null ? CORE_COLOR : palette[p.color]}"/>`).join('');
  const comps = parts.map((p, k) =>
    `<component objectid="${k + 1}" p:UUID="${uuid(20 + k)}"/>`).join('');

  const modelXml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<model unit="millimeter" xml:lang="en-US"` +
    ` xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"` +
    ` xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"` +
    ` xmlns:BambuStudio="http://schemas.bambulab.com/package/2021">` +
    `<metadata name="Application">puzzle-cube-generator</metadata>` +
    `<metadata name="BambuStudio:3mfVersion">1</metadata>` +
    `<resources>` +
    `<basematerials id="9">${mats}</basematerials>` +
    res +
    `<object id="6" p:UUID="${uuid(6)}" type="model"><components>${comps}</components></object>` +
    `</resources>` +
    // printable="1" is a de-facto BambuStudio attribute (their own writer
    // emits it unprefixed); harmless for core-spec consumers
    `<build p:UUID="${uuid(100)}"><item objectid="6" p:UUID="${uuid(101)}" printable="1"/></build>` +
    `</model>`;

  const settingsXml =
    `<?xml version="1.0" encoding="UTF-8"?>\n<config>\n` +
    `  <object id="6">\n` +
    `    <metadata key="name" value="puzzle-hint-cube"/>\n` +
    `    <metadata key="extruder" value="1"/>\n` +
    parts.map((p, k) =>
      `    <part id="${k + 1}" subtype="normal_part">\n` +
      `      <metadata key="name" value="${names[k]}"/>\n` +
      `      <metadata key="extruder" value="${p.color === null ? 1 : p.color + 1}"/>\n` +
      `    </part>\n`).join('') +
    `  </object>\n</config>\n`;

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>` +
    `<Default Extension="config" ContentType="text/xml"/>` +
    `</Types>`;

  const rels =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Target="/3D/3dmodel.model" Id="rel-1"` +
    ` Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>` +
    `</Relationships>`;

  const enc = new TextEncoder();
  return buildZipBytes([
    { name: '[Content_Types].xml', data: enc.encode(contentTypes) },
    { name: '_rels/.rels', data: enc.encode(rels) },
    { name: '3D/3dmodel.model', data: enc.encode(modelXml) },
    { name: 'Metadata/model_settings.config', data: enc.encode(settingsXml) },
  ]);
}

// Binary STL from a flat coordinate array (9 numbers per triangle)
function buildSTL(coords) {
  const triCount = coords.length / 9;
  const buf = new ArrayBuffer(84 + triCount * 50);
  const dv = new DataView(buf);
  const header = 'puzzle-cube generator';
  for (let i = 0; i < header.length; i++) dv.setUint8(i, header.charCodeAt(i));
  dv.setUint32(80, triCount, true);
  let off = 84;
  for (let k = 0; k < triCount; k++) {
    const o = k * 9;
    const ax = coords[o], ay = coords[o + 1], az = coords[o + 2];
    const bx = coords[o + 3], by = coords[o + 4], bz = coords[o + 5];
    const cx = coords[o + 6], cy = coords[o + 7], cz = coords[o + 8];
    let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const nl = Math.hypot(nx, ny, nz) || 1;
    dv.setFloat32(off, nx / nl, true); dv.setFloat32(off + 4, ny / nl, true); dv.setFloat32(off + 8, nz / nl, true);
    dv.setFloat32(off + 12, ax, true); dv.setFloat32(off + 16, ay, true); dv.setFloat32(off + 20, az, true);
    dv.setFloat32(off + 24, bx, true); dv.setFloat32(off + 28, by, true); dv.setFloat32(off + 32, bz, true);
    dv.setFloat32(off + 36, cx, true); dv.setFloat32(off + 40, cy, true); dv.setFloat32(off + 44, cz, true);
    dv.setUint16(off + 48, 0, true);
    off += 50;
  }
  return buf;
}

// STL for one plate. Flat pieces translate by (dx,dy); tilted pieces are
// rotated 45°×45° and each dropped so its own lowest point touches the bed.
// Textured pieces carry their relief on the z=t (top) side, so in flat
// mode both engraved and embossed text print letters-up as is.
function plateSTL(plate, model) {
  const coords = [];
  const c = model.c, t = model.t;
  for (const pc of plate.pieces) {
    const local = [];
    const emit = (...v) => local.push(...v);
    const cfg = model.textMasks ? model.textMasks[pc.piece.face] : null;
    if (cfg && pc.piece.hasText) buildTexturedPieceMesh(pc.piece, model, c, t, plate.clearance || 0, emit);
    else buildPieceMesh(pc.piece, c, t, plate.clearance || 0, emit);
    if (pc.tilt) {
      let zmin = Infinity;
      const tv = [];
      for (let k = 0; k < local.length; k += 3) {
        const v = tilt45(local[k], local[k + 1], local[k + 2]);
        tv.push(v);
        if (v[2] < zmin) zmin = v[2];
      }
      for (const v of tv) coords.push(v[0] + pc.tilt.dx, v[1] + pc.tilt.dy, v[2] - zmin);
    } else {
      for (let k = 0; k < local.length; k += 3) {
        coords.push(local[k] + pc.dx, local[k + 1] + pc.dy, local[k + 2]);
      }
    }
  }
  return buildSTL(coords);
}

/* ---------- Minimal ZIP (store, no compression) ---------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(data) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
// files: [{name, data: Uint8Array}] → zip bytes (store, no compression)
function buildZipBytes(files) {
  const encoder = new TextEncoder();
  const localParts = [], centralParts = [];
  let offset = 0;
  for (const f of files) {
    const nameB = encoder.encode(f.name);
    const crc = crc32(f.data);
    const local = new ArrayBuffer(30);
    const dv = new DataView(local);
    dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 0x0800, true);
    dv.setUint16(8, 0, true); dv.setUint16(10, 0, true); dv.setUint16(12, 0x21, true);
    dv.setUint32(14, crc, true); dv.setUint32(18, f.data.length, true); dv.setUint32(22, f.data.length, true);
    dv.setUint16(26, nameB.length, true); dv.setUint16(28, 0, true);
    localParts.push(new Uint8Array(local), nameB, f.data);

    const cen = new ArrayBuffer(46);
    const cv = new DataView(cen);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true); cv.setUint16(12, 0, true); cv.setUint16(14, 0x21, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, f.data.length, true); cv.setUint32(24, f.data.length, true);
    cv.setUint16(28, nameB.length, true);
    cv.setUint32(42, offset, true);
    centralParts.push(new Uint8Array(cen), nameB);
    offset += 30 + nameB.length + f.data.length;
  }
  let centralSize = 0;
  for (const p of centralParts) centralSize += p.length;
  const end = new ArrayBuffer(22);
  const ev = new DataView(end);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true);
  const all = [...localParts, ...centralParts, new Uint8Array(end)];
  let total = 0;
  for (const p of all) total += p.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of all) { out.set(p, pos); pos += p.length; }
  return out;
}
function buildZip(files) {
  return new Blob([buildZipBytes(files)], { type: 'application/zip' });
}
