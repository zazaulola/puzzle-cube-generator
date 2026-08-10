'use strict';
/* ============================================================
   preview.js — canvas rendering of the cube net and the plates
   ============================================================ */

const NET_LAYOUT = { F: [1, 1], R: [2, 1], B: [3, 1], L: [0, 1], T: [1, 2], Bo: [1, 0] };

function setupCanvas(canvas, cssW, cssH) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width = cssW + 'px';
  canvas.style.height = cssH + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

function tracePoly(ctx, poly, sx, sy, ox, oy) {
  ctx.beginPath();
  poly.forEach((p, k) => {
    const x = ox + p[0] * sx, y = oy + p[1] * sy;
    if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.closePath();
}

// Cube net (4×3 cross of faces)
function drawNet(canvas, model, palette, colorsCount) {
  const box = (canvas.closest('.view') || canvas.parentElement).getBoundingClientRect();
  const cssW = Math.max(320, box.width - 62);
  const pad = 34;
  const cell = (cssW - pad * 2) / 4;
  const cssH = cell * 3 + pad * 2;
  const ctx = setupCanvas(canvas, cssW, cssH);
  ctx.clearRect(0, 0, cssW, cssH);

  const s = (cell - 22) / model.L; // 22px reserved for labels between rows
  const css = getComputedStyle(document.documentElement);
  const ink = css.getPropertyValue('--ink-faint').trim() || '#5b6572';
  const lineCol = css.getPropertyValue('--bg-deep').trim() || '#0c1014';

  // pass 1 — pieces, pass 2 — labels (otherwise a later face paints over the text)
  for (const f of model.faces) {
    const [gx, gy] = NET_LAYOUT[f.name];
    const ox = pad + gx * cell + 3;
    const oy = pad + (2 - gy) * cell + 3 + model.L * s;
    // local Y goes up → down on canvas, hence negative sy
    for (const p of f.pieces) {
      ctx.fillStyle = colorsCount === 4 ? palette[p.color] : palette[0];
      tracePoly(ctx, p.poly, s, -s, ox, oy);
      ctx.fill();
      ctx.strokeStyle = lineCol;
      ctx.lineWidth = 1.1;
      ctx.stroke();
    }
  }
  // face text relief (engraved darker, embossed lighter)
  if (model.textMasks) {
    const NS = model.N * (model.SUB || TEXT_SUB);
    ctx.imageSmoothingEnabled = false;
    for (const f of model.faces) {
      const cfg = model.textMasks[f.name];
      if (!cfg) continue;
      const off = document.createElement('canvas');
      off.width = NS; off.height = NS;
      const octx = off.getContext('2d');
      const img = octx.createImageData(NS, NS);
      const [rr, gg, bb, aa] = cfg.style === 'emb' ? [255, 255, 255, 145] : [10, 14, 18, 150];
      for (let i = 0; i < NS * NS; i++) {
        if (!cfg.data[i]) continue;
        img.data[i * 4] = rr; img.data[i * 4 + 1] = gg;
        img.data[i * 4 + 2] = bb; img.data[i * 4 + 3] = aa;
      }
      octx.putImageData(img, 0, 0);
      const [gx, gy] = NET_LAYOUT[f.name];
      const ox = pad + gx * cell + 3;
      const oy = pad + (2 - gy) * cell + 3 + model.L * s;
      ctx.save();
      ctx.translate(ox, oy);
      ctx.scale(1, -1); // face v axis points up
      ctx.drawImage(off, 0, 0, NS, NS, 0, 0, model.L * s, model.L * s);
      ctx.restore();
    }
    ctx.imageSmoothingEnabled = true;
  }

  // hidden hemisphere fixators: dot = bump, ring = socket, on a separate
  // overlay canvas — CSS keeps it hidden unless body.debug is set
  const fixCv = document.getElementById('net-fix');
  if (fixCv) {
    const fctx = setupCanvas(fixCv, cssW, cssH);
    fctx.clearRect(0, 0, cssW, cssH);
    const rDot = Math.max(1.2, FIX_R * Math.sqrt(1 - FIX_SINK * FIX_SINK) * model.c * s * 0.9);
    fctx.lineWidth = 1;
    for (const f of model.faces) {
      const [gx, gy] = NET_LAYOUT[f.name];
      const ox = pad + gx * cell + 3;
      const oy = pad + (2 - gy) * cell + 3 + model.L * s;
      for (const p of f.pieces) {
        if (!p.feats || !p.outline) continue;
        const nOut = p.outline.length;
        for (const [k, type] of p.feats) {
          const P0 = p.outline[k], P1 = p.outline[(k + 1) % nOut];
          const mx = ((P0[0] + P1[0]) / 2) * model.c, my = ((P0[1] + P1[1]) / 2) * model.c;
          const px = ox + mx * s, py = oy - my * s;
          fctx.beginPath();
          if (type === 'bump') {
            fctx.fillStyle = 'rgba(12,16,20,0.75)';
            fctx.arc(px, py, rDot * 0.55, 0, 2 * Math.PI);
            fctx.fill();
          } else {
            fctx.strokeStyle = 'rgba(12,16,20,0.75)';
            fctx.arc(px, py, rDot, 0, 2 * Math.PI);
            fctx.stroke();
          }
        }
      }
    }
  }

  ctx.fillStyle = ink;
  ctx.font = '10px "IBM Plex Mono", monospace';
  ctx.textAlign = 'center';
  for (const f of model.faces) {
    const [gx, gy] = NET_LAYOUT[f.name];
    const ox = pad + gx * cell + 3;
    const oy = pad + (2 - gy) * cell + 3 + model.L * s;
    ctx.fillText(t('face_' + f.name).toUpperCase(), ox + model.L * s / 2, oy + 13);
  }

  // dimension line for the cube edge
  const [gx, gy] = NET_LAYOUT.Bo;
  const ox = pad + gx * cell + 3, oyTop = pad + (2 - gy) * cell + 3;
  const yDim = oyTop + model.L * s + 24;
  const accent = css.getPropertyValue('--accent').trim() || '#ffb454';
  ctx.strokeStyle = accent; ctx.fillStyle = accent;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(ox, yDim); ctx.lineTo(ox + model.L * s, yDim);
  ctx.moveTo(ox, yDim - 4); ctx.lineTo(ox, yDim + 4);
  ctx.moveTo(ox + model.L * s, yDim - 4); ctx.lineTo(ox + model.L * s, yDim + 4);
  ctx.stroke();
  ctx.font = '10px "IBM Plex Mono", monospace';
  ctx.textAlign = 'center';
  ctx.fillText(model.L.toFixed(0) + ' ' + t('mm'), ox + model.L * s / 2, yDim + 12);
}

/* Hint cube preview: two interactive, synchronously rotating cubes —
   the ASSEMBLED puzzle (real piece shapes, rim teeth included) and the
   hint cube (nominal 1×2 mosaics). Canvas-only 3D: orthographic
   projection, each cube face is an offscreen texture drawn through the
   affine transform of its projected quad (orthographic keeps face
   mapping affine, and a convex cube needs no depth sort — only
   backface culling). Dragging rotates both cubes about the screen
   axes; a slow idle spin resumes a few seconds after the last touch.
   Side by side on wide screens, stacked on narrow ones. */
const HINT_CORE_COLOR = '#9e9e9e';

function shadeHex(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const ch = v => Math.round(Math.max(0, Math.min(255, v * k)));
  return `rgb(${ch(n >> 16)},${ch((n >> 8) & 255)},${ch(n & 255)})`;
}

/* --- tiny 3×3 matrix helpers (rows are view axes) --- */
const m3mul = (A, B) => {
  const C = [];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      C[i * 3 + j] = A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j];
  return C;
};
const m3vec = (A, v) => [
  A[0] * v[0] + A[1] * v[1] + A[2] * v[2],
  A[3] * v[0] + A[4] * v[1] + A[5] * v[2],
  A[6] * v[0] + A[7] * v[1] + A[8] * v[2],
];
const m3rotX = a => [1, 0, 0, 0, Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a)];
const m3rotY = a => [Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a)];
const m3rotZ = a => [Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0, 0, 0, 1];

const HINT3D = {
  raf: 0, canvas: null, scene: null,
  // world→view: x' right, y' up, z' toward the viewer; starts as a ¾ view
  // of the front-top-right corner (F faces the viewer via [0,0,1] row 3)
  R: null, dragging: false, lastPointer: null, lastTouch: 0, bound: false,
};

function hintInitR() {
  const base = [1, 0, 0, 0, 0, 1, 0, -1, 0]; // x→right, z→up, −y→viewer
  // positive pitch tips the top toward the viewer, negative yaw turns the
  // right side in → ¾ top-front-right view
  return m3mul(m3rotX(0.42), m3mul(m3rotY(-0.55), base));
}

/* face texture painters — texture coords are the face's own (u,v), mm
   scaled to S px, NO flips: the affine quad mapping handles orientation */
function hintFaceTextures(model, palette, H, frame) {
  const d = model.difficulty, Q = 2 * d;
  const PHI = solveFacePhases(d);
  const faceIdx = Object.fromEntries(FACE_DEFS.map((fd, k) => [fd.name, k]));
  const f = frame ? HINT_FRAME : 0;
  const q = (H - 2 * f) / Q;
  const S = 256;
  const out = {};
  for (const fd of FACE_DEFS) out[fd.name] = null;
  const byFace = {};
  for (const p of model.pieces) (byFace[p.face] = byFace[p.face] || []).push(p);
  for (const fd of FACE_DEFS) {
    const cv = document.createElement('canvas');
    cv.width = S; cv.height = S;
    const ctx = cv.getContext('2d');
    if (frame) { ctx.fillStyle = HINT_CORE_COLOR; ctx.fillRect(0, 0, S, S); }
    const k = S / H;
    for (const p of byFace[fd.name] || []) {
      const r = hintRect(p, d, PHI, faceIdx);
      ctx.fillStyle = palette[p.color];
      const x = (f + r.qu0 * q) * k, y = (f + r.qv0 * q) * k;
      const w = (r.qu1 - r.qu0) * q * k, h = (r.qv1 - r.qv0) * q * k;
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = 'rgba(10,14,18,0.85)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x + 0.75, y + 0.75, w - 1.5, h - 1.5);
    }
    out[fd.name] = cv;
  }
  return out;
}

function asmFaceTextures(model, palette) {
  const N = model.N, L = model.L, c = model.c;
  const S = 512;
  const faceIdx = Object.fromEntries(FACE_DEFS.map((fd, k) => [fd.name, k]));
  // ownership grids (piece index per cell) for filling foreign rim voxels
  const own = FACE_DEFS.map(() => new Int32Array(N * N).fill(-1));
  model.pieces.forEach((p, idx) => {
    const g = own[faceIdx[p.face]];
    for (const [i, j] of p.cells) g[j * N + i] = idx;
  });
  const ctxs = {}, cvs = {};
  for (const fd of FACE_DEFS) {
    const cv = document.createElement('canvas');
    cv.width = S; cv.height = S;
    cvs[fd.name] = cv;
    ctxs[fd.name] = cv.getContext('2d');
  }
  const k = S / L;
  for (const face of model.faces) {
    const ctx = ctxs[face.name];
    for (const p of face.pieces) {
      ctx.fillStyle = palette[p.color];
      ctx.beginPath();
      p.poly.forEach((pt, i) => i === 0 ? ctx.moveTo(pt[0] * k, pt[1] * k) : ctx.lineTo(pt[0] * k, pt[1] * k));
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(10,14,18,0.85)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }
  // rim voxels owned by a neighboring face's piece live in that face's
  // grid — paint them here so the assembled faces read exactly like the
  // real cube (the interlocked edge teeth). Cells of the SAME owner are
  // merged: fills first, then separator strokes only on boundaries
  // between different owners (borders against the face's own pieces are
  // already stroked by their outlines).
  const foreign = FACE_DEFS.map(() => new Map()); // cellIdx → piece index
  for (const e of matchCubeEdges()) {
    const fa = faceIdx[e.a.face], fb = faceIdx[e.b.face];
    for (let kk = 1; kk <= N - 2; kk++) {
      const pa = sidePixel(e.a.side, kk, N);
      const pb = sidePixel(e.b.side, e.flip ? N - 1 - kk : kk, N);
      const oa = own[fa][pa[1] * N + pa[0]], ob = own[fb][pb[1] * N + pb[0]];
      if (oa >= 0 && ob < 0) foreign[fb].set(pb[1] * N + pb[0], oa);
      else if (ob >= 0 && oa < 0) foreign[fa].set(pa[1] * N + pa[0], ob);
    }
  }
  for (const group of matchCubeCorners()) {
    let ownerIdx = -1;
    const px = group.map(g => ({ p: cornerPixel(g, N), fi: faceIdx[g.face] }));
    for (const q2 of px) {
      const o = own[q2.fi][q2.p[1] * N + q2.p[0]];
      if (o >= 0) ownerIdx = o;
    }
    if (ownerIdx < 0) continue;
    for (const q2 of px) {
      if (own[q2.fi][q2.p[1] * N + q2.p[0]] < 0) foreign[q2.fi].set(q2.p[1] * N + q2.p[0], ownerIdx);
    }
  }
  FACE_DEFS.forEach((fd, fi) => {
    const ctx = ctxs[fd.name];
    const fmap = foreign[fi];
    const ownerAt = (i, j) => {
      if (i < 0 || j < 0 || i >= N || j >= N) return -2; // outside the face
      const fo = fmap.get(j * N + i);
      return fo !== undefined ? fo : own[fi][j * N + i];
    };
    for (const [cellIdx, idx] of fmap) {
      const i = cellIdx % N, j = (cellIdx / N) | 0;
      ctx.fillStyle = palette[model.pieces[idx].color];
      ctx.fillRect(i * c * k, j * c * k, c * k, c * k);
    }
    ctx.strokeStyle = 'rgba(10,14,18,0.85)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (const [cellIdx, idx] of fmap) {
      const i = cellIdx % N, j = (cellIdx / N) | 0;
      const x = i * c * k, y = j * c * k, w = c * k;
      const sides = [
        [i, j - 1, x, y, x + w, y],         // top edge of the cell
        [i, j + 1, x, y + w, x + w, y + w], // bottom
        [i - 1, j, x, y, x, y + w],         // left
        [i + 1, j, x + w, y, x + w, y + w], // right
      ];
      for (const [ni, nj, x1, y1, x2, y2] of sides) {
        const no = ownerAt(ni, nj);
        if (no !== idx && no !== -2) { ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); }
      }
    }
    ctx.stroke();
  });
  return cvs;
}

// shared "grab the surface" trackball: dragging right moves the front
// toward +rotY, dragging down tips the top toward the viewer (+rotX;
// screen y grows downward). st needs {R, dragging, lastPointer, lastTouch}.
function bindSpin(canvas, st) {
  if (st.bound) return;
  st.bound = true;
  canvas.style.cursor = 'grab';
  canvas.addEventListener('pointerdown', ev => {
    st.dragging = true;
    st.lastPointer = [ev.clientX, ev.clientY];
    st.lastTouch = performance.now();
    try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* synthetic events */ }
    canvas.style.cursor = 'grabbing';
    ev.preventDefault();
  });
  canvas.addEventListener('pointermove', ev => {
    if (!st.dragging) return;
    const dx = ev.clientX - st.lastPointer[0];
    const dy = ev.clientY - st.lastPointer[1];
    st.lastPointer = [ev.clientX, ev.clientY];
    st.lastTouch = performance.now();
    st.R = m3mul(m3rotX(dy * 0.008), m3mul(m3rotY(dx * 0.008), st.R));
  });
  const up = () => { st.dragging = false; st.lastTouch = performance.now(); canvas.style.cursor = 'grab'; };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
}
const hintBindPointer = canvas => bindSpin(canvas, HINT3D);

function hintFrame3D(now) {
  const st = HINT3D;
  const canvas = st.canvas;
  if (!canvas || !canvas.isConnected || canvas.offsetParent === null) { st.raf = 0; return; }
  if (!st.dragging && now - st.lastTouch > 2500) {
    // idle turntable: spin about the cube's own vertical (world z) so the
    // current tilt is preserved — post-multiplied = world-space rotation
    HINT3D.R = m3mul(st.R, m3rotZ(0.0035));
  }
  const { texAsm, texHint, model, H } = st.scene;
  const box = (canvas.closest('.view') || canvas.parentElement).getBoundingClientRect();
  const cssW = Math.max(300, box.width - 62);
  const stacked = cssW < 620;
  const D = stacked ? Math.min(cssW - 40, 280) : Math.min((cssW - 80) / 2, 300);
  const slotW = stacked ? cssW : cssW / 2;
  const cssH = stacked ? 2 * (D + 62) + 14 : D + 76;
  if (canvas.__w !== cssW || canvas.__h !== cssH) {
    setupCanvas(canvas, cssW, cssH);
    canvas.__w = cssW; canvas.__h = cssH;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  const css = getComputedStyle(document.documentElement);
  const ink = css.getPropertyValue('--ink-faint').trim() || '#5b6572';
  const lineCol = css.getPropertyValue('--bg-deep').trim() || '#0c1014';

  // half the cube's diagonal fits in D/2 → scale
  const scale = D / Math.sqrt(3);
  const cubes = [
    { tex: texAsm, edge: model.L, label: t('hintAsmLabel') },
    { tex: texHint, edge: H, label: t('hintGuideLabel') },
  ];
  cubes.forEach((cube, ci) => {
    const cx = stacked ? cssW / 2 : slotW * ci + slotW / 2;
    const cy = (stacked ? ci * (D + 62) : 0) + D / 2 + 16;
    const proj = p => {
      // world is [0,1]³ here (unit cube), centered before rotating
      const v = m3vec(st.R, [p[0] - 0.5, p[1] - 0.5, p[2] - 0.5]);
      return [cx + v[0] * scale, cy - v[1] * scale, v[2]];
    };
    for (const fd of FACE_DEFS) {
      const W = [
        fd.U[1] * fd.V[2] - fd.U[2] * fd.V[1],
        fd.U[2] * fd.V[0] - fd.U[0] * fd.V[2],
        fd.U[0] * fd.V[1] - fd.U[1] * fd.V[0],
      ];
      const nView = m3vec(st.R, W);
      if (nView[2] <= 0.001) continue; // backface
      const P0 = proj(fd.O);
      const PU = proj([fd.O[0] + fd.U[0], fd.O[1] + fd.U[1], fd.O[2] + fd.U[2]]);
      const PV = proj([fd.O[0] + fd.V[0], fd.O[1] + fd.V[1], fd.O[2] + fd.V[2]]);
      const tex = cube.tex[fd.name];
      const S = tex.width;
      ctx.save();
      // affine: texture (tx,ty) → P0 + tx/S·(PU−P0) + ty/S·(PV−P0)
      ctx.transform(
        (PU[0] - P0[0]) / S, (PU[1] - P0[1]) / S,
        (PV[0] - P0[0]) / S, (PV[1] - P0[1]) / S,
        P0[0], P0[1]);
      ctx.drawImage(tex, 0, 0);
      ctx.restore();
      // face path for shading + edge stroke
      const PUV = proj([
        fd.O[0] + fd.U[0] + fd.V[0],
        fd.O[1] + fd.U[1] + fd.V[1],
        fd.O[2] + fd.U[2] + fd.V[2]]);
      ctx.beginPath();
      ctx.moveTo(P0[0], P0[1]);
      ctx.lineTo(PU[0], PU[1]);
      ctx.lineTo(PUV[0], PUV[1]);
      ctx.lineTo(PV[0], PV[1]);
      ctx.closePath();
      const shade = 0.42 * (1 - Math.max(0, Math.min(1, nView[2])));
      if (shade > 0.01) { ctx.fillStyle = `rgba(6,9,12,${shade.toFixed(3)})`; ctx.fill(); }
      ctx.strokeStyle = lineCol;
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
    ctx.fillStyle = ink;
    ctx.font = '10px "IBM Plex Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`${cube.label.toUpperCase()} · ${cube.edge.toFixed(0)} ${t('mm')}`, cx, cy + D / 2 + 26);
  });
  ctx.fillStyle = ink;
  ctx.font = '9px "IBM Plex Mono", monospace';
  ctx.textAlign = 'center';
  ctx.fillText(t('hintDragTip'), cssW / 2, cssH - 8);

  st.raf = requestAnimationFrame(hintFrame3D);
}

// (Re)initializes the interactive scene; the current rotation survives
// rebuilds (palette/size/frame/model changes), the RAF loop self-stops
// whenever the canvas container is hidden.
function drawHint(canvas, model, palette, H, frame) {
  HINT3D.canvas = canvas;
  if (!HINT3D.R) HINT3D.R = hintInitR();
  HINT3D.scene = {
    model, H,
    texAsm: asmFaceTextures(model, palette),
    texHint: hintFaceTextures(model, palette, H, frame),
  };
  hintBindPointer(canvas);
  canvas.__w = -1; // force resize on next frame
  if (!HINT3D.raf) HINT3D.raf = requestAnimationFrame(hintFrame3D);
}

/* Interactive 3D view of one print plate: pieces as extruded prisms on
   the bed, same trackball + idle turntable as the hint cubes. Pieces are
   rendered as bottom cap → depth-sorted side walls → top cap (painter's
   algorithm; the pieces themselves are depth-sorted by centroid, and
   they never overlap in XY on the bed, so this ordering is exact enough
   for a preview). Tilted plates get the real 45°×45° pose. Sub-mm
   details (fixators, text relief) are intentionally omitted. */
const PLATE3D = {
  raf: 0, canvas: null, scene: null,
  R: null, dragging: false, lastPointer: null, lastTouch: 0, bound: false,
};

function plateInitR() {
  // bird's-eye view of the bed, slicer-style: top view pitched back
  return m3mul(m3rotX(0.95), [1, 0, 0, 0, 1, 0, 0, 0, 1]);
}

function plateFrame3D(now) {
  const st = PLATE3D;
  const canvas = st.canvas;
  if (!canvas || !canvas.isConnected || canvas.offsetParent === null) { st.raf = 0; return; }
  if (!st.dragging && now - st.lastTouch > 2500) {
    st.R = m3mul(st.R, m3rotZ(0.0035)); // turntable about the bed's vertical
  }
  const { pieces, bedW, bedH, label } = st.scene;
  const box = (canvas.closest('.view') || canvas.parentElement).getBoundingClientRect();
  const cssW = Math.max(300, box.width - 62);
  const D = Math.min(cssW - 30, 560);
  const cssH = Math.min(440, D * 0.72) + 46;
  if (canvas.__w !== cssW || canvas.__h !== cssH) {
    setupCanvas(canvas, cssW, cssH);
    canvas.__w = cssW; canvas.__h = cssH;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  const css = getComputedStyle(document.documentElement);
  const ink = css.getPropertyValue('--ink-faint').trim() || '#5b6572';
  const bedFill = css.getPropertyValue('--bg-deep').trim() || '#0c1014';
  const bedLine = css.getPropertyValue('--line-strong').trim() || '#34414f';

  const cx = cssW / 2, cy = (cssH - 30) / 2 + 8;
  const scale = D / Math.hypot(bedW, bedH);
  const ctr = [bedW / 2, bedH / 2, 0];
  const proj = p => {
    const v = m3vec(st.R, [p[0] - ctr[0], p[1] - ctr[1], p[2] - ctr[2]]);
    return [cx + v[0] * scale, cy - v[1] * scale, v[2]];
  };

  // the bed (drawn first when seen from above; covers pieces from below)
  const bedUp = m3vec(st.R, [0, 0, 1])[2] > 0;
  const drawBed = () => {
    const C = [proj([0, 0, 0]), proj([bedW, 0, 0]), proj([bedW, bedH, 0]), proj([0, bedH, 0])];
    ctx.beginPath();
    C.forEach((p, i) => i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1]));
    ctx.closePath();
    ctx.fillStyle = bedFill;
    ctx.fill();
    ctx.strokeStyle = bedLine;
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(120,140,160,0.13)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let g = 50; g < bedW; g += 50) {
      const a = proj([g, 0, 0]), b = proj([g, bedH, 0]);
      ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
    }
    for (let g = 50; g < bedH; g += 50) {
      const a = proj([0, g, 0]), b = proj([bedW, g, 0]);
      ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
    }
    ctx.stroke();
  };
  if (bedUp) drawBed();

  // pieces, far to near
  const order = pieces.map((pc, i) => {
    const v = m3vec(st.R, [pc.ctr[0] - ctr[0], pc.ctr[1] - ctr[1], pc.ctr[2] - ctr[2]]);
    return [v[2], i];
  }).sort((a, b) => a[0] - b[0]);
  for (const [, pi] of order) {
    const pc = pieces[pi];
    const n = pc.B.length;
    const B = pc.B.map(proj), T = pc.T.map(proj);
    // piece axis (bottom→top) in view space decides which cap is near
    const axis = m3vec(st.R, pc.axis);
    const topNear = axis[2] > 0;
    const capPath = P => {
      ctx.beginPath();
      P.forEach((p, i) => i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1]));
      ctx.closePath();
    };
    // far cap
    capPath(topNear ? B : T);
    ctx.fillStyle = shadeHex(pc.color, 0.5);
    ctx.fill();
    // walls, far to near (depth = mean view z of the wall's corners)
    const walls = [];
    for (let i2 = 0; i2 < n; i2++) {
      const j2 = (i2 + 1) % n;
      walls.push([ (B[i2][2] + B[j2][2] + T[i2][2] + T[j2][2]) / 4, i2, j2 ]);
    }
    walls.sort((a, b) => a[0] - b[0]);
    for (const [, i2, j2] of walls) {
      // lambert-ish: wall normal from the 3D edge × axis
      const ex = pc.B3[j2][0] - pc.B3[i2][0], ey = pc.B3[j2][1] - pc.B3[i2][1], ez = pc.B3[j2][2] - pc.B3[i2][2];
      const nx = ey * pc.axis[2] - ez * pc.axis[1];
      const ny = ez * pc.axis[0] - ex * pc.axis[2];
      const nz = ex * pc.axis[1] - ey * pc.axis[0];
      const nl = Math.hypot(nx, ny, nz) || 1;
      const nvz = m3vec(st.R, [nx / nl, ny / nl, nz / nl])[2];
      const k = 0.45 + 0.4 * Math.max(0, nvz);
      ctx.beginPath();
      ctx.moveTo(B[i2][0], B[i2][1]);
      ctx.lineTo(B[j2][0], B[j2][1]);
      ctx.lineTo(T[j2][0], T[j2][1]);
      ctx.lineTo(T[i2][0], T[i2][1]);
      ctx.closePath();
      ctx.fillStyle = shadeHex(pc.color, k);
      ctx.fill();
    }
    // near cap + outline
    capPath(topNear ? T : B);
    ctx.fillStyle = shadeHex(pc.color, topNear ? 1.0 : 0.62);
    ctx.fill();
    ctx.strokeStyle = 'rgba(6,9,12,0.8)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  if (!bedUp) drawBed();

  ctx.fillStyle = ink;
  ctx.font = '10px "IBM Plex Mono", monospace';
  ctx.textAlign = 'center';
  ctx.fillText(`${label} · ${bedW}×${bedH} ${t('mm')}`, cssW / 2, cssH - 22);
  ctx.font = '9px "IBM Plex Mono", monospace';
  ctx.fillText(t('hintDragTip'), cssW / 2, cssH - 8);

  st.raf = requestAnimationFrame(plateFrame3D);
}

// (Re)initializes the 3D plate scene; rotation survives plate switches.
function drawPlate3D(canvas, plate, model, palette, colorsCount, label) {
  PLATE3D.canvas = canvas;
  if (!PLATE3D.R) PLATE3D.R = plateInitR();
  const t2 = model.t;
  const pieces = plate.pieces.map(pc => {
    const poly = pc.piece.poly;
    let B3, T3, axis;
    if (pc.tilt) {
      const rB = poly.map(p => tilt45(p[0], p[1], 0));
      const rT = poly.map(p => tilt45(p[0], p[1], t2));
      let zmin = Infinity;
      for (const v of rB) zmin = Math.min(zmin, v[2]);
      for (const v of rT) zmin = Math.min(zmin, v[2]);
      B3 = rB.map(v => [v[0] + pc.tilt.dx, v[1] + pc.tilt.dy, v[2] - zmin]);
      T3 = rT.map(v => [v[0] + pc.tilt.dx, v[1] + pc.tilt.dy, v[2] - zmin]);
      const a0 = tilt45(0, 0, 0), a1 = tilt45(0, 0, 1);
      axis = [a1[0] - a0[0], a1[1] - a0[1], a1[2] - a0[2]];
    } else {
      B3 = poly.map(p => [p[0] + pc.dx, p[1] + pc.dy, 0]);
      T3 = poly.map(p => [p[0] + pc.dx, p[1] + pc.dy, t2]);
      axis = [0, 0, 1];
    }
    let sx = 0, sy = 0, sz = 0;
    for (const v of B3) { sx += v[0]; sy += v[1]; sz += v[2]; }
    return {
      B3, T3, axis,
      B: B3, T: T3, // projected in-frame (aliases; proj() maps per frame)
      ctr: [sx / B3.length, sy / B3.length, sz / B3.length + t2 / 2],
      color: colorsCount === 4 ? palette[pc.piece.color] : palette[0],
    };
  });
  PLATE3D.scene = { pieces, bedW: plate.bedW, bedH: plate.bedH, label };
  bindSpin(canvas, PLATE3D);
  canvas.__w = -1;
  if (!PLATE3D.raf) PLATE3D.raf = requestAnimationFrame(plateFrame3D);
}

// A single plate
function drawPlate(canvas, plate, thickness, palette, colorsCount, maxCss) {
  const cssW = maxCss;
  const s = (cssW - 20) / plate.bedW;
  const cssH = plate.bedH * s + 20;
  const ctx = setupCanvas(canvas, cssW, cssH);
  const css = getComputedStyle(document.documentElement);
  ctx.clearRect(0, 0, cssW, cssH);

  const ox = 10, oy = 10;
  // the plate
  ctx.fillStyle = css.getPropertyValue('--bg-deep').trim() || '#0c1014';
  ctx.strokeStyle = css.getPropertyValue('--line').trim() || '#242c35';
  ctx.lineWidth = 1;
  ctx.fillRect(ox, oy, plate.bedW * s, plate.bedH * s);
  ctx.strokeRect(ox, oy, plate.bedW * s, plate.bedH * s);
  // 50 mm grid
  ctx.strokeStyle = 'rgba(120,140,160,0.10)';
  ctx.beginPath();
  for (let g = 50; g < plate.bedW; g += 50) { ctx.moveTo(ox + g * s, oy); ctx.lineTo(ox + g * s, oy + plate.bedH * s); }
  for (let g = 50; g < plate.bedH; g += 50) { ctx.moveTo(ox, oy + g * s); ctx.lineTo(ox + plate.bedW * s, oy + g * s); }
  ctx.stroke();

  for (const pc of plate.pieces) {
    const col = colorsCount === 4 ? palette[pc.piece.color] : palette[0];
    ctx.fillStyle = col;
    if (pc.poly2) {
      // tilted piece: lower ring dimmed, upper ring on top
      ctx.globalAlpha = 0.45;
      tracePoly(ctx, pc.poly, s, s, ox, oy);
      ctx.fill();
      ctx.globalAlpha = 1;
      tracePoly(ctx, pc.poly2, s, s, ox, oy);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.45)';
      ctx.lineWidth = 0.8;
      ctx.stroke();
    } else {
      tracePoly(ctx, pc.poly, s, s, ox, oy);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.45)';
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }
  }
  return cssH;
}
