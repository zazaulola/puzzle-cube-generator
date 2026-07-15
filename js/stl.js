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
   annulus. */
function wallWithFixator(A, B, t, r, dir, emit) {
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
  const events = ring.concat(corners).sort((a, b) => a.ang - b.ang);
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
function plateSTL(plate, model) {
  const coords = [];
  const c = model.c, t = model.t;
  for (const pc of plate.pieces) {
    const local = [];
    const emit = (...v) => local.push(...v);
    buildPieceMesh(pc.piece, c, t, plate.clearance || 0, emit);
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
// files: [{name, data: Uint8Array}]
function buildZip(files) {
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
  return new Blob([...localParts, ...centralParts, new Uint8Array(end)], { type: 'application/zip' });
}
