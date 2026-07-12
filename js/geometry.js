'use strict';
/* ============================================================
   geometry.js — core entities: PRNG, cube faces, matching of
   cube edges and corners between faces.
   Model: the cube is a hollow box of 6 flat faces; a face is an
   N×N grid of cells (N = 8·difficulty), plate thickness equals
   the cell size, so the rim cells of a face are voxels shared
   with the neighboring faces.
   ============================================================ */

// ---------- Deterministic PRNG ----------
function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function makeRng(seedStr) { return mulberry32(xmur3(String(seedStr))()); }

// ---------- Cube faces: 3D frames ----------
// Unit cube [0..1]³. O — origin, U/V — axes of the local (u,v) coords.
const FACE_DEFS = [
  { name: 'F',  O: [0, 0, 0], U: [1, 0, 0],  V: [0, 0, 1] },
  { name: 'R',  O: [1, 0, 0], U: [0, 1, 0],  V: [0, 0, 1] },
  { name: 'B',  O: [1, 1, 0], U: [-1, 0, 0], V: [0, 0, 1] },
  { name: 'L',  O: [0, 1, 0], U: [0, -1, 0], V: [0, 0, 1] },
  { name: 'T',  O: [0, 0, 1], U: [1, 0, 0],  V: [0, 1, 0] },
  { name: 'Bo', O: [0, 1, 0], U: [1, 0, 0],  V: [0, -1, 0] },
];

// Face sides; the parameter s runs from point A to B (in 0..1 fractions)
const SIDE_DEFS = {
  S: { A: [0, 0], B: [1, 0] },
  E: { A: [1, 0], B: [1, 1] },
  N: { A: [0, 1], B: [1, 1] },
  W: { A: [0, 0], B: [0, 1] },
};

function local3d(face, u, v) {
  return [
    face.O[0] + u * face.U[0] + v * face.V[0],
    face.O[1] + u * face.U[1] + v * face.V[1],
    face.O[2] + u * face.U[2] + v * face.V[2],
  ];
}
function ptEq(a, b) {
  return Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9 && Math.abs(a[2] - b[2]) < 1e-9;
}

// Rim pixel: position k (0..N-1) along a side → face cell (i,j)
function sidePixel(side, k, N) {
  switch (side) {
    case 'S': return [k, 0];
    case 'E': return [N - 1, k];
    case 'N': return [k, N - 1];
    case 'W': return [0, k];
  }
}

// The 12 cube edges: pairs (face, side) whose 3D segments coincide.
// flip=true when the side parameters run head-on (k ↔ N-1-k).
function matchCubeEdges() {
  const sides = [];
  for (const f of FACE_DEFS) {
    for (const sName of Object.keys(SIDE_DEFS)) {
      const sd = SIDE_DEFS[sName];
      sides.push({
        face: f.name, side: sName,
        A: local3d(f, sd.A[0], sd.A[1]),
        B: local3d(f, sd.B[0], sd.B[1]),
      });
    }
  }
  const edges = [];
  for (let i = 0; i < sides.length; i++) {
    for (let j = i + 1; j < sides.length; j++) {
      const a = sides[i], b = sides[j];
      if (a.face === b.face) continue;
      const direct = ptEq(a.A, b.A) && ptEq(a.B, b.B);
      const flipped = ptEq(a.A, b.B) && ptEq(a.B, b.A);
      if (direct || flipped) {
        edges.push({ a: { face: a.face, side: a.side }, b: { face: b.face, side: b.side }, flip: flipped });
      }
    }
  }
  return edges; // exactly 12
}

// The 8 cube corners: groups of three face corner cells meeting at one
// 3D point. Each entry: { face, cu, cv } (cu/cv ∈ {0,1} — which face corner).
function matchCubeCorners() {
  const map = new Map();
  for (const f of FACE_DEFS) {
    for (const cu of [0, 1]) {
      for (const cv of [0, 1]) {
        const p = local3d(f, cu, cv).map(x => Math.round(x * 4) / 4).join(',');
        if (!map.has(p)) map.set(p, []);
        map.get(p).push({ face: f.name, cu, cv });
      }
    }
  }
  return [...map.values()]; // 8 groups of 3
}

function cornerPixel(cornerRef, N) {
  return [cornerRef.cu ? N - 1 : 0, cornerRef.cv ? N - 1 : 0];
}

// Rim cell: the kc-th cell (0..d-1) along a side → (I,J) in the cell grid
function sideCell(side, kc, d) {
  switch (side) {
    case 'S': return [kc, 0];
    case 'E': return [d - 1, kc];
    case 'N': return [kc, d - 1];
    case 'W': return [0, kc];
  }
}

/* Checkerboard phases of the faces. Split orientation of cell (I,J) on
   face f: o = (I + J + phi[f]) % 2; o=0 — 8×4 elements run along local u,
   o=1 — along v. We pick phi so that across EVERY cube edge the adjacent
   cells alternate: one has elements along the edge, the other across it.
   Within a face the checkerboard propagates this automatically, so one
   anchor cell pair per edge suffices. Sides S/N run along u, E/W along v.
   The solution depends on the parity of d (odd d needs other phases). */
const _phaseCache = new Map();
function solveFacePhases(d) {
  if (_phaseCache.has(d)) return _phaseCache.get(d);
  const edges = matchCubeEdges();
  const idx = Object.fromEntries(FACE_DEFS.map((f, k) => [f.name, k]));
  const alongU = side => side === 'S' || side === 'N';
  let found = null;
  for (let mask = 0; mask < 64 && !found; mask++) {
    const phi = FACE_DEFS.map((_, k) => (mask >> k) & 1);
    let ok = true;
    for (const e of edges) {
      const [Ia, Ja] = sideCell(e.a.side, 0, d);
      const [Ib, Jb] = sideCell(e.b.side, e.flip ? d - 1 : 0, d);
      const oA = (Ia + Ja + phi[idx[e.a.face]]) % 2;
      const oB = (Ib + Jb + phi[idx[e.b.face]]) % 2;
      const parA = alongU(e.a.side) ? oA === 0 : oA === 1; // elements along the edge?
      const parB = alongU(e.b.side) ? oB === 0 : oB === 1;
      if (parA === parB) { ok = false; break; }
    }
    if (ok) found = phi;
  }
  if (!found) found = FACE_DEFS.map((_, k) => k % 2); // unreachable
  _phaseCache.set(d, found);
  return found;
}
