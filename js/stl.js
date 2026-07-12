'use strict';
/* ============================================================
   stl.js — triangulation, extrusion, binary STL, ZIP (store)
   ============================================================ */

// Ear clipping for a simple polygon (CCW). Returns triples of indices.
function triangulate(poly) {
  const n = poly.length;
  if (n < 3) return [];
  let pts = poly;
  if (signedArea(pts) < 0) pts = [...pts].reverse();
  const V = [...Array(pts.length).keys()];
  const tris = [];
  let guard = 0, i = 0;
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const inTri = (p, a, b, c) =>
    cross(a, b, p) >= -1e-9 && cross(b, c, p) >= -1e-9 && cross(c, a, p) >= -1e-9;
  while (V.length > 3 && guard < 30000) {
    guard++;
    const m = V.length;
    const i0 = V[(i - 1 + m) % m], i1 = V[i % m], i2 = V[(i + 1) % m];
    const a = pts[i0], b = pts[i1], c = pts[i2];
    let ear = cross(a, b, c) > 1e-9;
    if (ear) {
      for (const vi of V) {
        if (vi === i0 || vi === i1 || vi === i2) continue;
        if (inTri(pts[vi], a, b, c)) { ear = false; break; }
      }
    }
    if (ear) { tris.push([i0, i1, i2]); V.splice(i % m, 1); i = 0; }
    else i++;
    if (i > 2 * V.length) { // degeneracy: clip by force, skipping zero-area ears
      if (Math.abs(cross(pts[V[0]], pts[V[1]], pts[V[2]])) > 1e-9)
        tris.push([V[0], V[1], V[2]]);
      V.splice(1, 1); i = 0;
    }
  }
  if (V.length === 3) tris.push([V[0], V[1], V[2]]);
  // map indices back to the original orientation
  if (pts !== poly) {
    const map = i => poly.length - 1 - i;
    return tris.map(t => [map(t[0]), map(t[2]), map(t[1])]);
  }
  return tris;
}

// Piece mesh: outline poly (mm) + thickness t → flat triangle array [ax,ay,az, bx..., cx...]
function extrudePiece(poly, t, out) {
  let pts = poly;
  if (signedArea(pts) < 0) pts = [...pts].reverse(); // CCW
  const tris = triangulate(pts);
  for (const [a, b, c] of tris) {
    // top cap (normal +z)
    out.push(pts[a][0], pts[a][1], t, pts[b][0], pts[b][1], t, pts[c][0], pts[c][1], t);
    // bottom cap (normal -z)
    out.push(pts[a][0], pts[a][1], 0, pts[c][0], pts[c][1], 0, pts[b][0], pts[b][1], 0);
  }
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    // side wall (outward for CCW)
    out.push(p[0], p[1], 0, q[0], q[1], 0, q[0], q[1], t);
    out.push(p[0], p[1], 0, q[0], q[1], t, p[0], p[1], t);
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

// STL for a single plate
function plateSTL(plate, thickness) {
  const coords = [];
  for (const pc of plate.pieces) extrudePiece(pc.poly, thickness, coords);
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
