'use strict';
/* ============================================================
   pieces.js — the pixel model of the puzzle pieces.

   A face is N×N cells (N = 8·d). Each 8×8 block ("tile") is cut
   into two 8×4 elements; the cut orientation follows a
   checkerboard. Borders between elements inside a face wander
   randomly by −1/0/+1 cells. Along cube edges every rim cell
   goes to exactly one of the two faces (−1/+1, never flush);
   each cube corner cell goes randomly to one of the three
   elements meeting there. Plate thickness equals the cell size,
   so rim cells are voxels shared between neighboring faces.
   Diagonal "pinches" are repaired locally; cell ownership is
   always limited to elements whose nominal area is within ±1
   cell. Every element is checked for shape uniqueness
   (8 symmetries).
   ============================================================ */

const CELL = 8; // cells per tile (an 8×8 tile → two 8×4 elements)

/* Dovetail flare, in cell units per side. 0 = plain straight pixel
   teeth (uniform look, friction fit — tune with slicer XY compensation).
   Values around 0.15 turn every tooth into a locking dovetail, but the
   flared in-face seams then look different from the cube-edge joints. */
const DOVETAIL = 0;

/* Hidden snap fixator: a hemisphere centered on the mating face of a
   cell, with a matching hemispherical socket on the neighbor. Fixators
   sit between the pieces and are invisible from outside; being
   rotationally symmetric, they never betray the piece orientation or
   the cube face boundaries (edge-tooth walls get them too). The bump
   side is chosen randomly but deterministically by seed.
   Radius in cell units. */
const FIX_R = 0.28;

function pieceCount(d) { return 12 * d * d; }

function buildPuzzle(params) {
  const { difficulty: d, colors, L, seed } = params;
  const N = CELL * d;
  const c = L / N; // cell size, mm (= plate thickness)
  let built = null, attempt = 0;
  for (; attempt < 100; attempt++) {
    built = tryBuild(d, N, makeRng(seed + '|' + d + '|' + attempt), false);
    if (built) break;
  }
  if (!built) { // last resort: drop the uniqueness requirement
    for (let a = 0; a < 50 && !built; a++) built = tryBuild(d, N, makeRng(seed + '|' + d + '|fb' + a), true);
  }
  if (!built) throw new Error('Failed to generate a valid cutting — try another seed');

  // Per-face ownership grids — the dovetail rule needs to know which
  // element owns each of the four cells around an outline vertex.
  const faceIdx = Object.fromEntries(FACE_DEFS.map((fd, k) => [fd.name, k]));
  const ownerGrid = FACE_DEFS.map(() => new Int32Array(N * N).fill(-1));
  built.elements.forEach((el, k) => {
    const g = ownerGrid[faceIdx[el.face]];
    for (const [i, j] of el.cells) g[j * N + i] = k;
  });
  const cellAt = (fi, i, j) =>
    (i < 0 || j < 0 || i >= N || j >= N) ? -1 : ownerGrid[fi][j * N + i];

  /* Dovetail displacement of an outline vertex. Around every corner of
     the pixel outline sit four cells; on a two-piece wall the pattern is
     3+1, and moving the vertex diagonally AWAY from the minority cell
     widens tooth tips and narrows tooth bases. Both pieces compute the
     same displacement for the shared point, so the fit stays exact.
     Vertices next to the face rim, foreign voxels or 3-piece junctions
     are left in place (the 3D edge joints must stay straight). */
  const dovetail = (fi, x, y) => {
    if (!DOVETAIL) return [x, y];
    const quads = [[x - 1, y - 1], [x, y - 1], [x - 1, y], [x, y]];
    const owners = quads.map(q => cellAt(fi, q[0], q[1]));
    if (owners.includes(-1)) return [x, y];
    const uniq = [...new Set(owners)];
    if (uniq.length !== 2) return [x, y];
    const minority = uniq.find(o => owners.filter(v => v === o).length === 1);
    if (minority === undefined) return [x, y]; // 2–2 pattern
    const [ci, cj] = quads[owners.indexOf(minority)];
    const qx = ci >= x ? 1 : -1, qy = cj >= y ? 1 : -1;
    return [x - qx * DOVETAIL, y - qy * DOVETAIL];
  };

  /* Per outline unit edge: the material cell and the neighbor cell.
     Directions follow traceOutline (CCW, material on the left). */
  const edgeCells = (P0, P1) => {
    const dx = P1[0] - P0[0], dy = P1[1] - P0[1];
    if (dx === 1) return { cell: [P0[0], P0[1]], nb: [P0[0], P0[1] - 1] };
    if (dy === 1) return { cell: [P0[0] - 1, P0[1]], nb: [P0[0], P0[1]] };
    if (dx === -1) return { cell: [P0[0] - 1, P0[1] - 1], nb: [P0[0] - 1, P0[1]] };
    return { cell: [P0[0], P0[1] - 1], nb: [P0[0] - 1, P0[1] - 1] };
  };

  const faces = FACE_DEFS.map(fd => ({ name: fd.name, pieces: [] }));
  const byName = Object.fromEntries(faces.map(f => [f.name, f]));
  const pieces = [];
  for (const el of built.elements) {
    const fi = faceIdx[el.face];
    // hemisphere fixators on this piece's walls: outline edge index → type
    const feats = new Map();
    const nOut = el.outline.length;
    for (let k = 0; k < nOut; k++) {
      const P0 = el.outline[k], P1 = el.outline[(k + 1) % nOut];
      const { cell, nb } = edgeCells(P0, P1);
      if (nb[0] < 0 || nb[1] < 0 || nb[0] >= N || nb[1] >= N) continue;
      const c1 = built.canonKeyOf(fi, cell[0], cell[1]);
      const c2 = built.canonKeyOf(fi, nb[0], nb[1]);
      const fk = c1 < c2 ? c1 + '<' + c2 : c2 + '<' + c1;
      const bumpOwner = built.fixators.get(fk);
      if (bumpOwner === undefined) continue;
      feats.set(k, bumpOwner === el.num ? 'bump' : 'socket');
    }
    const piece = {
      id: el.id, face: el.face, color: 0,
      poly: mergeCollinear(el.outline.map(p => {
        const [x, y] = dovetail(fi, p[0], p[1]);
        return [x * c, y * c];
      })),
      outline: el.outline, // unit-resolution loop (mesh generation)
      cells: el.cells,
      feats,
      cellCount: el.cells.length,
    };
    byName[el.face].pieces.push(piece);
    pieces.push(piece);
  }
  const model = {
    L, c, t: c, N, difficulty: d, faces, pieces,
    adjacency: built.adjacency,
    unique: built.unique,
    attempts: attempt + 1,
  };
  if (colors === 4) colorize(model, makeRng(seed + '|colors|' + d));
  return model;
}

/* One generation attempt. Returns null when the layout could not be
   made valid (the caller retries with another randomness stream). */
function tryBuild(d, N, rng, force) {
  const NF = FACE_DEFS.length;
  const perFace = 2 * d * d;

  // Nominal owner of cell (i,j) on face fi — an integer element id.
  // Checkerboard phases are consistent across cube edges (solveFacePhases).
  const PHI = solveFacePhases(d);
  const nom = (fi, i, j) => {
    const I = (i / CELL) | 0, J = (j / CELL) | 0;
    const horiz = (I + J + PHI[fi]) % 2 === 0; // o=0: 8×4 elements along u
    const half = horiz ? (((j % CELL) < CELL / 2) ? 0 : 1)
                       : (((i % CELL) < CELL / 2) ? 0 : 1);
    return (fi * d * d + I * d + J) * 2 + half;
  };
  const elemFace = id => (id / (2 * d * d)) | 0;

  // Ownership maps, starting from the nominal layout
  const own = [];
  for (let fi = 0; fi < NF; fi++) {
    const m = new Int32Array(N * N);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) m[j * N + i] = nom(fi, i, j);
    own.push(m);
  }

  /* In-face borders, profile-based: collect the list of nominal pair
     borders; for each border draw a random profile of per-position
     offsets from {−1, 0, +1}, excluding the constant profiles — a
     constant profile is a straight line, and a straight border leaves
     the pieces unattached. Deterministic for a given seed. */
  for (let fi = 0; fi < NF; fi++) {
    const m = own[fi];
    const borders = new Map(); // pairKey → [{ aCell, bCell, a, b }] in scan order
    const record = (a, b, aCell, bCell) => {
      const k = a < b ? a + '|' + b : b + '|' + a;
      if (!borders.has(k)) borders.set(k, []);
      borders.get(k).push({ aCell, bCell, a, b });
    };
    for (let j = 1; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const a = nom(fi, i, j - 1), b = nom(fi, i, j);
        if (a !== b) record(a, b, [i, j - 1], [i, j]);
      }
    }
    for (let i = 1; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const a = nom(fi, i - 1, j), b = nom(fi, i, j);
        if (a !== b) record(a, b, [i - 1, j], [i, j]);
      }
    }
    for (const bk of [...borders.keys()].sort()) {
      const list = borders.get(bk);
      let profile, guard = 0;
      do {
        profile = list.map(() => ((rng() * 3) | 0) - 1);
        guard++;
      } while (guard < 20 && profile.every(o => o === profile[0]));
      if (profile.every(o => o === profile[0])) profile[0] = profile[0] === 1 ? -1 : 1;
      list.forEach((pos, s) => {
        const o = profile[s];
        if (o === 1) m[pos.bCell[1] * N + pos.bCell[0]] = pos.a;      // a bites into b
        else if (o === -1) m[pos.aCell[1] * N + pos.aCell[0]] = pos.b; // b bites into a
      });
    }
  }

  const faceIdx = Object.fromEntries(FACE_DEFS.map((f, k) => [f.name, k]));
  const key = (fi, i, j) => fi * N * N + j * N + i;
  const unkey = k => [(k / (N * N)) | 0, k % N, ((k % (N * N)) / N) | 0]; // [fi, i, j]

  // Shared voxels: cube edges (2 aliases) and cube corners (3 aliases)
  const aliasOf = new Map(); // key → canonical key
  const groups = new Map();  // canonical key → [all keys of the group]
  const vox = new Map();     // canonical key → owning element (dice roll)

  for (const e of matchCubeEdges()) {
    const fa = faceIdx[e.a.face], fb = faceIdx[e.b.face];
    // Candidates per position (corner cells are handled separately).
    const pos = [];
    for (let k = 1; k <= N - 2; k++) {
      const pa = sidePixel(e.a.side, k, N);
      const pb = sidePixel(e.b.side, e.flip ? N - 1 - k : k, N);
      const ka = key(fa, pa[0], pa[1]), kb = key(fb, pb[0], pb[1]);
      aliasOf.set(kb, ka); aliasOf.set(ka, ka);
      groups.set(ka, [ka, kb]);
      pos.push({ ka, va: own[fa][pa[1] * N + pa[0]], vb: own[fb][pb[1] * N + pb[0]] });
    }
    /* −1/+1 tooth lottery, windowed: within a maximal run where the two
       candidate pieces stay the same, a constant sequence would hand the
       whole contact to one side — the pair would then touch only via cap
       faces, with no shared side wall and no fixator. Windows of length
       ≥2 are forced to be non-constant, so every such pair gets at least
       one lateral fixator wall across the cube edge. */
    let s = 0;
    while (s < pos.length) {
      let epos = s + 1;
      while (epos < pos.length && pos[epos].va === pos[s].va && pos[epos].vb === pos[s].vb) epos++;
      const len = epos - s;
      let seq, guard = 0;
      do {
        seq = [];
        for (let q = 0; q < len; q++) seq.push(rng() < 0.5);
        guard++;
      } while (len >= 2 && guard < 20 && seq.every(x => x === seq[0]));
      if (len >= 2 && seq.every(x => x === seq[0])) seq[0] = !seq[0];
      for (let q = 0; q < len; q++) vox.set(pos[s + q].ka, seq[q] ? pos[s + q].va : pos[s + q].vb);
      s = epos;
    }
  }
  for (const group of matchCubeCorners()) {
    const ks = group.map(g => {
      const fi = faceIdx[g.face], px = cornerPixel(g, N);
      return { k: key(fi, px[0], px[1]), v: own[fi][px[1] * N + px[0]] };
    });
    const rep = ks[0].k;
    for (const q of ks) aliasOf.set(q.k, rep);
    groups.set(rep, ks.map(q => q.k));
    vox.set(rep, ks[(rng() * ks.length) | 0].v); // a corner goes to one of three
  }

  // Resolved ownership map (all aliases kept in sync)
  const res = own.map(m => Int32Array.from(m));
  const setOwner = (kk, v) => {
    const ck = aliasOf.has(kk) ? aliasOf.get(kk) : kk;
    const grp = groups.get(ck) || [ck];
    for (const ak of grp) {
      const [fi, i, j] = unkey(ak);
      res[fi][j * N + i] = v;
    }
  };
  for (const [ck, v] of vox) setOwner(ck, v);
  const owner = (fi, i, j) => res[fi][j * N + i];

  // Allowed owners of a cell: nominal owners of the 3×3 neighborhoods of
  // all its aliases — a border never drifts more than ±1 cell from nominal
  const legalCache = new Map();
  const legal = (kk) => {
    const ck = aliasOf.has(kk) ? aliasOf.get(kk) : kk;
    if (legalCache.has(ck)) return legalCache.get(ck);
    const set = new Set();
    for (const ak of (groups.get(ck) || [ck])) {
      const [fi, i, j] = unkey(ak);
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const x = i + di, y = j + dj;
          if (x < 0 || y < 0 || x >= N || y >= N) continue;
          set.add(nom(fi, x, y));
        }
      }
    }
    legalCache.set(ck, set);
    return set;
  };

  // ---- Pinch repair (diagonal touch of same-element cells) ----
  const findPinch = () => {
    for (let fi = 0; fi < NF; fi++) {
      for (let j = 0; j < N - 1; j++) {
        for (let i = 0; i < N - 1; i++) {
          const a = owner(fi, i, j), b = owner(fi, i + 1, j);
          const p = owner(fi, i, j + 1), q = owner(fi, i + 1, j + 1);
          if (a === q && a !== b && a !== p) return { fi, i, j, main: true };
          if (b === p && b !== a && b !== q) return { fi, i, j, main: false };
        }
      }
    }
    return null;
  };
  const repairPinch = (pn) => {
    const { fi, i, j, main } = pn;
    const X = key(fi, i, j), B = key(fi, i + 1, j), C = key(fi, i, j + 1), D = key(fi, i + 1, j + 1);
    // main: element e sits at X and D with holes at B and C; otherwise e at B,C
    const e = main ? owner(fi, i, j) : owner(fi, i + 1, j);
    const holes = main ? [B, C] : [X, D];
    const cells = main ? [X, D] : [B, C];
    // 1) grant the element one of the missing cells
    for (const h of holes) {
      if (legal(h).has(e)) { setOwner(h, e); return true; }
    }
    // 2) take one of the diagonal cells away from the element
    for (const cc of cells) {
      for (const h of holes) {
        const [hf, hi, hj] = unkey(aliasOf.has(h) ? aliasOf.get(h) : h);
        const alt = res[hf][hj * N + hi]; // owner of the hole
        if (alt !== e && legal(cc).has(alt)) { setOwner(cc, alt); return true; }
      }
    }
    return false;
  };

  // Element cells (in the element's own face coordinates)
  const collectCells = () => {
    const map = new Map();
    for (let fi = 0; fi < NF; fi++) {
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const v = owner(fi, i, j);
          if (elemFace(v) !== fi) continue; // foreign voxel
          if (!map.has(v)) map.set(v, []);
          map.get(v).push([i, j]);
        }
      }
    }
    return map;
  };

  // Voxel neighbors (via all aliases — also works across cube edges)
  const voxelNeighbors = (kk) => {
    const ck = aliasOf.has(kk) ? aliasOf.get(kk) : kk;
    const out = [];
    for (const ak of (groups.get(ck) || [ck])) {
      const [fi, i, j] = unkey(ak);
      if (i > 0) out.push(key(fi, i - 1, j));
      if (i < N - 1) out.push(key(fi, i + 1, j));
      if (j > 0) out.push(key(fi, i, j - 1));
      if (j < N - 1) out.push(key(fi, i, j + 1));
    }
    return out;
  };

  // Fragment stitching: disconnected shards of an element are handed
  // over to neighboring elements (within the ±1 cell tolerance)
  const stitchFragments = () => {
    let changed = false;
    const map = collectCells();
    if (map.size !== NF * perFace) return null;
    for (const [e, cells] of map) {
      const comps = componentsOf(cells);
      if (comps.length <= 1) continue;
      comps.sort((a, b) => b.length - a.length);
      let pending = [];
      for (let q = 1; q < comps.length; q++) pending.push(...comps[q]);
      const fe = elemFace(e);
      let guard = 0;
      while (pending.length && guard++ < 300) {
        let progressed = false;
        const rest = [];
        for (const [i, j] of pending) {
          const kk = key(fe, i, j);
          const lg = legal(kk);
          let target = -1;
          for (const nk of voxelNeighbors(kk)) {
            const [nf, ni, nj] = unkey(nk);
            const o = res[nf][nj * N + ni];
            if (o !== e && lg.has(o)) { target = o; break; }
          }
          if (target >= 0) { setOwner(kk, target); changed = true; progressed = true; }
          else rest.push([i, j]);
        }
        pending = rest;
        if (!progressed) break;
      }
      if (pending.length) return null; // nobody can take the shard
    }
    return { changed };
  };

  // Alternate pinch repair and stitching until stable
  const runRepairs = () => {
    let stable = false;
    for (let round = 0; round < 40 && !stable; round++) {
      let guard = 0;
      while (guard++ < 600) {
        const pn = findPinch();
        if (!pn) break;
        if (!repairPinch(pn)) return false;
      }
      if (findPinch()) return false;
      const st = stitchFragments();
      if (st === null) return false;
      stable = !st.changed;
    }
    return stable;
  };
  if (!runRepairs()) return null;

  // Shared walls of every adjacent in-face pair (by current ownership)
  const wallCellPair = w => w.vert
    ? [[w.x0 - 1, w.y0], [w.x0, w.y0]]
    : [[w.x0, w.y0 - 1], [w.x0, w.y0]];
  const collectPairWalls = () => {
    const map = new Map();
    for (let fi = 0; fi < NF; fi++) {
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const p = owner(fi, i, j);
          const add = (q, wall) => {
            if (p === q || elemFace(p) !== fi || elemFace(q) !== fi) return;
            const k = Math.min(p, q) + '|' + Math.max(p, q);
            if (!map.has(k)) map.set(k, []);
            map.get(k).push(wall);
          };
          if (i + 1 < N) add(owner(fi, i + 1, j), { fi, x0: i + 1, y0: j, x1: i + 1, y1: j + 1, vert: 1, lo: p, hi: owner(fi, i + 1, j) });
          if (j + 1 < N) add(owner(fi, i, j + 1), { fi, x0: i, y0: j + 1, x1: i + 1, y1: j + 1, vert: 0, lo: p, hi: owner(fi, i, j + 1) });
        }
      }
    }
    return map;
  };
  const isFlatContact = walls => walls.every(w => w.vert === walls[0].vert &&
    (w.vert ? w.x0 === walls[0].x0 : w.y0 === walls[0].y0));

  // Wiggle long perfectly straight contacts: force one ±1 steal across
  // the border, then repair again. The snap fixator would hold a flat
  // pair anyway, but the shapes should interlock too.
  for (let cycle = 0; cycle < 5; cycle++) {
    const pw = collectPairWalls();
    let changed = false;
    for (const k of [...pw.keys()].sort()) {
      const walls = pw.get(k);
      if (walls.length < 2 || !isFlatContact(walls)) continue;
      const w = walls[(walls.length / 2) | 0];
      const [cLo, cHi] = wallCellPair(w);
      const kLo = key(w.fi, cLo[0], cLo[1]), kHi = key(w.fi, cHi[0], cHi[1]);
      const steals = rng() < 0.5
        ? [[kHi, w.lo], [kLo, w.hi]]
        : [[kLo, w.hi], [kHi, w.lo]];
      for (const [ck, newOwner] of steals) {
        if (legal(ck).has(newOwner)) { setOwner(ck, newOwner); changed = true; break; }
      }
    }
    if (!changed) break;
    if (!runRepairs()) return null;
  }

  const cellsOf = collectCells();

  // ---- Validation (geometric checks are always hard) ----
  if (cellsOf.size !== NF * perFace) return null; // an element vanished
  for (const [, cells] of cellsOf) {
    if (cells.length < 16) return null;   // eaten away too much
    if (!isConnected(cells)) return null;
  }
  // Uniqueness of all elements (rotations + reflections); force skips it
  const sigs = new Set();
  let unique = true;
  for (const [, cells] of cellsOf) {
    const s = canonicalSig(cells);
    if (sigs.has(s)) { unique = false; if (!force) return null; }
    sigs.add(s);
  }

  // ---- Hidden hemisphere fixators ----
  // Every wall between two cells of different pieces gets one fixator:
  // a hemisphere bump on a random (seed-deterministic) side and a
  // matching socket on the other. Walls where both cells are shared
  // voxels (cube-edge teeth) count too — the piece-to-piece contact is
  // wall-to-wall there just like inside a face, so the seams over the
  // cube edges are indistinguishable from in-face seams. Walls against
  // a foreign face's plate interior (cap contacts) are skipped.
  const canonOf = kk => (aliasOf.has(kk) ? aliasOf.get(kk) : kk);
  // Faces whose grid contains this voxel (shared voxels live in 2–3 grids)
  const facesOf = ck => (groups.get(ck) || [ck]).map(k => (k / (N * N)) | 0);
  // Qualified walls per adjacent piece pair. A wall qualifies when it is
  // a SIDE wall of both owners' prisms: both voxels have to be visible
  // in each owner's face grid (at cube corners a wall can be a side wall
  // for one piece but a cap face for the other — skip those).
  const pairWallsQ = new Map(); // 'a|b' → [{fk, x, y, vert}] in scan order
  const seenWall = new Set();
  for (let fi = 0; fi < NF; fi++) {
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const o1 = owner(fi, i, j);
        const k1 = key(fi, i, j);
        const consider = (i2, j2, wall) => {
          const o2 = owner(fi, i2, j2);
          if (o1 === o2) return;
          const c1 = canonOf(k1), c2 = canonOf(key(fi, i2, j2));
          const f1s = facesOf(c1), f2s = facesOf(c2);
          const fo1 = elemFace(o1), fo2 = elemFace(o2);
          if (!f1s.includes(fo1) || !f2s.includes(fo1)) return;
          if (!f1s.includes(fo2) || !f2s.includes(fo2)) return;
          const fk = c1 < c2 ? c1 + '<' + c2 : c2 + '<' + c1;
          if (seenWall.has(fk)) return;
          seenWall.add(fk);
          const pk = Math.min(o1, o2) + '|' + Math.max(o1, o2);
          if (!pairWallsQ.has(pk)) pairWallsQ.set(pk, []);
          pairWallsQ.get(pk).push({ fk, ...wall });
        };
        if (i + 1 < N) consider(i + 1, j, { x: i + 1, y: j + 0.5, vert: 1 });
        if (j + 1 < N) consider(i, j + 1, { x: i + 0.5, y: j + 1, vert: 0 });
      }
    }
  }
  /* Load-bearing walls only. Pulling two pieces apart happens across the
     contact's principal direction; a hemisphere on a wall FACING that
     pull slides straight out of its socket and carries nothing (shear
     along the seam is already blocked by the teeth themselves). Only
     walls whose normal runs ALONG the contact — the tooth flanks — force
     the bump to climb out of the socket, so only they get fixators:
     one near the middle of the seam, a second on long contacts. */
  const fixators = new Map(); // fk → bump owner element id
  for (const pk of [...pairWallsQ.keys()].sort()) {
    const ws = pairWallsQ.get(pk);
    const [pa, pb] = pk.split('|').map(Number);
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (const w of ws) {
      if (w.x < xMin) xMin = w.x; if (w.x > xMax) xMax = w.x;
      if (w.y < yMin) yMin = w.y; if (w.y > yMax) yMax = w.y;
    }
    const principalX = (xMax - xMin) >= (yMax - yMin);
    let useful = ws.filter(w => (principalX ? w.vert === 1 : w.vert === 0));
    if (!useful.length) useful = ws; // incidental 1-wall contacts etc.
    useful.sort((a, b) => principalX ? (a.x - b.x || a.y - b.y) : (a.y - b.y || a.x - b.x));
    let picks;
    if (ws.length >= 8 && useful.length >= 2) {
      const q1 = Math.floor((useful.length - 1) * 0.3);
      const q2 = Math.ceil((useful.length - 1) * 0.7);
      picks = q1 === q2 ? [useful[q1]] : [useful[q1], useful[q2]];
    } else {
      picks = [useful[Math.floor(useful.length / 2)]];
    }
    for (const w of picks) fixators.set(w.fk, rng() < 0.5 ? pa : pb);
  }

  // ---- Outlines and adjacency ----
  const ids = [...cellsOf.keys()].sort((a, b) => a - b);
  const elements = [];
  for (const id of ids) {
    const cells = cellsOf.get(id);
    const outline = traceOutline(cells);
    if (!outline) return null;
    const fi = elemFace(id);
    const I = ((id / 2 | 0) % (d * d) / d) | 0, J = (id / 2 | 0) % d, half = id % 2;
    elements.push({
      id: `${FACE_DEFS[fi].name}-${I}-${J}-${half}`,
      num: id, face: FACE_DEFS[fi].name, cells, outline,
    });
  }
  // Adjacency via shared voxel sides (inside faces and across cube edges)
  const idToIdx = new Map(ids.map((id, k) => [id, k]));
  const adj = elements.map(() => new Set());
  for (let fi = 0; fi < NF; fi++) {
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const a = owner(fi, i, j);
        if (i + 1 < N) {
          const b = owner(fi, i + 1, j);
          if (a !== b) { adj[idToIdx.get(a)].add(idToIdx.get(b)); adj[idToIdx.get(b)].add(idToIdx.get(a)); }
        }
        if (j + 1 < N) {
          const b = owner(fi, i, j + 1);
          if (a !== b) { adj[idToIdx.get(a)].add(idToIdx.get(b)); adj[idToIdx.get(b)].add(idToIdx.get(a)); }
        }
      }
    }
  }
  return {
    elements, adjacency: adj.map(s => [...s]), unique, fixators,
    canonKeyOf: (fi, i, j) => canonOf(key(fi, i, j)),
    ownerAt: (fi, i, j) => (i < 0 || j < 0 || i >= N || j >= N) ? -1 : owner(fi, i, j),
  };
}

// ---------- Connected components (4-neighborhood) ----------
function componentsOf(cells) {
  const set = new Map(cells.map(p => [p[0] + ',' + p[1], p]));
  const seen = new Set();
  const comps = [];
  for (const [k0, p0] of set) {
    if (seen.has(k0)) continue;
    const comp = [];
    const stack = [p0];
    seen.add(k0);
    while (stack.length) {
      const [x, y] = stack.pop();
      comp.push([x, y]);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const k = (x + dx) + ',' + (y + dy);
        if (set.has(k) && !seen.has(k)) { seen.add(k); stack.push(set.get(k)); }
      }
    }
    comps.push(comp);
  }
  return comps;
}

// ---------- Connectivity (4-neighborhood) ----------
function isConnected(cells) {
  const set = new Set(cells.map(p => p[0] + ',' + p[1]));
  const seen = new Set([cells[0][0] + ',' + cells[0][1]]);
  const stack = [cells[0]];
  while (stack.length) {
    const [x, y] = stack.pop();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const k = (x + dx) + ',' + (y + dy);
      if (set.has(k) && !seen.has(k)) { seen.add(k); stack.push([x + dx, y + dy]); }
    }
  }
  return seen.size === cells.length;
}

// ---------- Canonical shape signature (8 symmetries) ----------
function canonicalSig(cells) {
  const T = [
    (x, y) => [x, y], (x, y) => [-y, x], (x, y) => [-x, -y], (x, y) => [y, -x],
    (x, y) => [-x, y], (x, y) => [y, x], (x, y) => [x, -y], (x, y) => [-y, -x],
  ];
  let best = null;
  for (const tr of T) {
    const pts = cells.map(p => tr(p[0], p[1]));
    let mx = Infinity, my = Infinity;
    for (const p of pts) { if (p[0] < mx) mx = p[0]; if (p[1] < my) my = p[1]; }
    const s = pts.map(p => (p[0] - mx) + ',' + (p[1] - my)).sort().join(';');
    if (best === null || s < best) best = s;
  }
  return best;
}

// ---------- Outline of a pixel shape (CCW, material on the left) ----------
function traceOutline(cells) {
  const set = new Set(cells.map(p => p[0] + ',' + p[1]));
  const has = (i, j) => set.has(i + ',' + j);
  const next = new Map(); // "x,y" → [x,y]
  let total = 0;
  for (const [i, j] of cells) {
    if (!has(i, j - 1)) { next.set(i + ',' + j, [i + 1, j]); total++; }
    if (!has(i + 1, j)) { next.set((i + 1) + ',' + j, [i + 1, j + 1]); total++; }
    if (!has(i, j + 1)) { next.set((i + 1) + ',' + (j + 1), [i, j + 1]); total++; }
    if (!has(i - 1, j)) { next.set(i + ',' + (j + 1), [i, j]); total++; }
  }
  if (next.size !== total) return null; // pinch: two edges leave one point
  const startKey = [...next.keys()].sort()[0];
  const start = startKey.split(',').map(Number);
  const poly = [];
  let cur = start, steps = 0;
  do {
    poly.push(cur);
    const nk = cur[0] + ',' + cur[1];
    const nxt = next.get(nk);
    if (!nxt) return null;
    next.delete(nk);
    cur = nxt;
    if (++steps > total + 2) return null;
  } while (cur[0] !== start[0] || cur[1] !== start[1]);
  if (next.size !== 0) return null; // a hole or a second loop remains
  // NB: collinear points are kept — the dovetail displacement must see
  // every boundary grid point so neighboring pieces stay complementary;
  // merging happens after displacement (mergeCollinear).
  return poly;
}

// Drop vertices whose adjacent edges are collinear
function mergeCollinear(poly) {
  const out = [];
  const n = poly.length;
  for (let k = 0; k < n; k++) {
    const p0 = poly[(k - 1 + n) % n], p1 = poly[k], p2 = poly[(k + 1) % n];
    const cr = (p1[0] - p0[0]) * (p2[1] - p1[1]) - (p1[1] - p0[1]) * (p2[0] - p1[0]);
    if (Math.abs(cr) > 1e-9) out.push(p1);
  }
  return out;
}

/* ---------- 4-coloring ----------
   Exact backtracking search in DSATUR order (the graph is planar, so a
   solution exists); if the budget runs out — local conflict repair. */
function colorize(model, rng) {
  const n = model.pieces.length, adj = model.adjacency;
  const colors = new Array(n).fill(-1);
  const usage = [0, 0, 0, 0];
  let steps = 0;
  const LIMIT = 500000;

  const pick = () => {
    let best = -1, bs = -1, bd = -1;
    for (let v = 0; v < n; v++) {
      if (colors[v] !== -1) continue;
      const sat = new Set();
      for (const u of adj[v]) if (colors[u] !== -1) sat.add(colors[u]);
      const s = sat.size, deg = adj[v].length;
      if (s > bs || (s === bs && (deg > bd || (deg === bd && rng() < 0.5)))) { best = v; bs = s; bd = deg; }
    }
    return best;
  };
  const solve = (depth) => {
    if (steps++ > LIMIT) return false;
    if (depth === n) return true;
    const v = pick();
    const used = new Set();
    for (const u of adj[v]) if (colors[u] !== -1) used.add(colors[u]);
    const avail = [0, 1, 2, 3].filter(c => !used.has(c))
      .sort((a, b) => usage[a] - usage[b] || rng() - 0.5);
    for (const c of avail) {
      colors[v] = c; usage[c]++;
      if (solve(depth + 1)) return true;
      colors[v] = -1; usage[c]--;
    }
    return false;
  };

  let solved = false;
  for (let restart = 0; restart < 6 && !solved; restart++) {
    colors.fill(-1); usage.fill(0); steps = 0;
    solved = solve(0);
  }
  if (!solved) {
    // safety net: greedy coloring + local repair with Kempe chains
    for (let v = 0; v < n; v++) { colors[v] = v % 4; }
    const kempe = (v, b) => { // swap colors a↔b in the {a,b} component containing v
      const a = colors[v];
      const comp = new Set([v]);
      const stack = [v];
      while (stack.length) {
        const x = stack.pop();
        for (const u of adj[x]) {
          if (!comp.has(u) && (colors[u] === a || colors[u] === b)) { comp.add(u); stack.push(u); }
        }
      }
      for (const x of comp) colors[x] = colors[x] === a ? b : a;
    };
    let sinceImprove = 0, bestBad = Infinity;
    for (let it = 0; it < 200000; it++) {
      const bad = [];
      for (let v = 0; v < n; v++) {
        for (const u of adj[v]) if (colors[u] === colors[v]) { bad.push(v); break; }
      }
      if (!bad.length) break;
      if (bad.length < bestBad) { bestBad = bad.length; sinceImprove = 0; } else sinceImprove++;
      const v = bad[(rng() * bad.length) | 0];
      if (sinceImprove > 400) { // plateau — a Kempe kick
        kempe(v, (colors[v] + 1 + ((rng() * 3) | 0)) % 4);
        sinceImprove = 0;
        continue;
      }
      let bestC = colors[v], bestScore = Infinity;
      for (let c = 0; c < 4; c++) {
        let conf = 0;
        for (const u of adj[v]) if (colors[u] === c) conf++;
        const score = conf * 1000 + (c === colors[v] ? 500 : 0) + rng();
        if (score < bestScore) { bestScore = score; bestC = c; }
      }
      colors[v] = bestC;
    }
    usage.fill(0);
    for (let v = 0; v < n; v++) usage[colors[v]]++;
  }
  let conflicts = 0;
  for (let v = 0; v < n; v++) for (const u of adj[v]) if (u > v && colors[u] === colors[v]) conflicts++;
  model.pieces.forEach((p, k) => { p.color = colors[k]; });
  model.colorUsage = usage;
  model.colorConflicts = conflicts;
}
