'use strict';
/* ============================================================
   app.js — state, UI wiring, file export
   ============================================================ */

const COLOR_NAMES = ['c1', 'c2', 'c3', 'c4'];
const DEFAULT_PALETTE = ['#e8543f', '#f4b942', '#3e9e6e', '#3d7dd8'];
const state = {
  difficulty: 2,
  colors: 4,
  scale: 1,
  autoEdge: true,   // pick the largest cube edge that fits the plates
  baseEdge: 80,     // cube edge at 1x (manual mode), mm
  maxCell: 6,       // cap on the cell size in auto mode, mm (print time!)
  orient: 'flat',   // print orientation: 'flat' | 'tilt' (45°×45°, supports)
  // Clearance per side, mm. Tilted prints come out tighter and get a
  // nominal gap; flat prints rely on the snap fixators alone.
  tiltClearance: 0.1,
  bedW: 256,        // print plate size, mm (fixed)
  bedH: 256,
  seed: 'cube-001',
  hintCube: false,  // add a small solid color-guide cube to the file set
  hintEdge: 30,     // its edge, mm
  hintFrame: false, // core-colored frame around each face mosaic
  palette: [...DEFAULT_PALETTE],
  // face → relief config. Text: { mode:'text', t (multi-line), h, v, s, f }.
  // Image: { mode:'image', img (base64 jpeg, no data: prefix), h, v, s,
  // scale (0..1), dither, invert }. h: l|c|r, v: t|m|b, s: eng|emb.
  texts: {},
};

/* ---------- Face text rasterization (browser canvas) ---------- */

/* Text fonts. Webfonts (Google Fonts, loaded in index.html) are checked
   against the actual text so the cyrillic subsets get pulled in too;
   until a font arrives the text rasterizes with the fallback and the
   model regenerates once the real font is ready. */
const TEXT_FONTS = {
  f0: { css: px => `900 ${px}px Arial, sans-serif`, probe: null },
  f1: { css: px => `${px}px Lobster, cursive`, probe: '32px Lobster' },
  f2: { css: px => `700 ${px}px Caveat, cursive`, probe: '700 32px Caveat' },
  f3: { css: px => `800 ${px}px "Playfair Display", serif`, probe: '800 32px "Playfair Display"' },
};
const _fontTried = {};
function ensureFont(fk, sample) {
  const F = TEXT_FONTS[fk];
  if (!F || !F.probe || !document.fonts) return;
  try {
    if (document.fonts.check(F.probe, sample)) return;
    if (_fontTried[fk]) return; // one attempt per session — avoid regen loops
    _fontTried[fk] = 1;
    document.fonts.load(F.probe, sample).then(() => {
      if (document.fonts.check(F.probe, sample)) regenerate();
    });
  } catch (e) { /* offline / no FontFaceSet — fallback font is fine */ }
}

function rasterizeTextFace(cfg, NS, SUB) {
  const lines = (cfg.t || '').replace(/\r/g, '').split('\n')
    .map(s => s.slice(0, 32)).slice(0, 6);
  if (!lines.join('').trim()) return null;
  const font = TEXT_FONTS[cfg.f] || TEXT_FONTS.f0;
  ensureFont(cfg.f, lines.join(''));
  const cv = document.createElement('canvas');
  cv.width = NS; cv.height = NS;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const m = SUB + Math.max(2, Math.round(NS * 0.03)); // ≥1 cell off the rim
  const availW = NS - 2 * m, availH = NS - 2 * m;
  let px = Math.max(5, Math.floor(availH / lines.length / 1.2));
  for (let iter = 0; iter < 8; iter++) {
    ctx.font = font.css(px);
    const wMax = Math.max(...lines.map(s => ctx.measureText(s).width), 1);
    if (wMax <= availW || px <= 5) break;
    px = Math.max(5, Math.floor(px * availW / wMax));
  }
  ctx.font = font.css(px);
  const lineH = px * 1.2;
  const blockH = lines.length * lineH;
  const y0 = cfg.v === 't' ? m : cfg.v === 'b' ? NS - m - blockH : (NS - blockH) / 2;
  ctx.fillStyle = '#000';
  ctx.textAlign = cfg.h === 'l' ? 'left' : cfg.h === 'r' ? 'right' : 'center';
  const x = cfg.h === 'l' ? m : cfg.h === 'r' ? NS - m : NS / 2;
  lines.forEach((s, i) => ctx.fillText(s, x, y0 + i * lineH + px * 0.8));
  const img = ctx.getImageData(0, 0, NS, NS).data;
  const data = new Uint8Array(NS * NS);
  let any = false;
  for (let y = 0; y < NS; y++) {
    for (let xx = 0; xx < NS; xx++) {
      // hard guarantee: nothing within the rim cell band
      if (xx < SUB || y < SUB || xx >= NS - SUB || y >= NS - SUB) continue;
      // 100 (not 128): calligraphic strokes are thinner and antialiased —
      // a slightly lower threshold keeps hairline parts printable
      if (img[(y * NS + xx) * 4 + 3] > 100) {
        data[(NS - 1 - y) * NS + xx] = 1; // face v axis points up
        any = true;
      }
    }
  }
  return any ? data : null;
}

/* ---------- Face image imprint (browser canvas) ---------- */

// Decoded <img> elements per face, keyed by the stored base64 payload so a
// re-rasterize (e.g. after a difficulty change) reuses the same bitmap; a
// fresh upload replaces the key and triggers a fresh decode.
const imgElCache = new Map(); // face → { key, el }
function getImageEl(face, b64) {
  const c = imgElCache.get(face);
  if (c && c.key === b64) return c.el; // el is null while still decoding
  const el = new Image();
  imgElCache.set(face, { key: b64, el: null });
  el.onload = () => {
    const c2 = imgElCache.get(face);
    if (c2 && c2.key === b64) { c2.el = el; regenerate(); }
  };
  el.src = 'data:image/jpeg;base64,' + b64;
  return null;
}

// 8×8 Bayer ordered-dither threshold matrix (0..63) — echoes the puzzle's
// own 8-cell tile rhythm and turns grayscale gradients into a clean
// halftone of on/off subpixels instead of a single hard edge.
const BAYER8 = [
  0, 32, 8, 40, 2, 34, 10, 42,
  48, 16, 56, 24, 50, 18, 58, 26,
  12, 44, 4, 36, 14, 46, 6, 38,
  60, 28, 52, 20, 62, 30, 54, 22,
  3, 35, 11, 43, 1, 33, 9, 41,
  51, 19, 59, 27, 49, 17, 57, 25,
  15, 47, 7, 39, 13, 45, 5, 37,
  63, 31, 55, 23, 61, 29, 53, 21,
];

function rasterizeImageFace(face, cfg, NS, SUB) {
  if (!cfg.img) return null;
  const el = getImageEl(face, cfg.img);
  if (!el) return null; // still decoding — its onload will regenerate()
  const cv = document.createElement('canvas');
  cv.width = NS; cv.height = NS;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const m = SUB + Math.max(2, Math.round(NS * 0.03)); // ≥1 cell off the rim
  const avail = NS - 2 * m;
  const box = avail * Math.max(0.1, Math.min(1, cfg.scale ?? 0.85));
  const ar = (el.naturalWidth || 1) / (el.naturalHeight || 1);
  const dw = ar >= 1 ? box : box * ar;
  const dh = ar >= 1 ? box / ar : box;
  const x0 = cfg.h === 'l' ? m : cfg.h === 'r' ? NS - m - dw : m + (avail - dw) / 2;
  const y0 = cfg.v === 't' ? m : cfg.v === 'b' ? NS - m - dh : m + (avail - dh) / 2;
  ctx.drawImage(el, x0, y0, dw, dh);
  const img = ctx.getImageData(0, 0, NS, NS).data;
  const data = new Uint8Array(NS * NS);
  const dither = cfg.dither !== false;
  let any = false;
  for (let y = 0; y < NS; y++) {
    for (let x = 0; x < NS; x++) {
      if (x < SUB || y < SUB || x >= NS - SUB || y >= NS - SUB) continue;
      const idx = (y * NS + x) * 4;
      if (img[idx + 3] < 16) continue; // transparent — no mark
      let lum = 0.299 * img[idx] + 0.587 * img[idx + 1] + 0.114 * img[idx + 2];
      if (cfg.invert) lum = 255 - lum;
      const on = dither
        ? lum < (BAYER8[(y & 7) * 8 + (x & 7)] + 0.5) / 64 * 255
        : lum < 128;
      if (on) { data[(NS - 1 - y) * NS + x] = 1; any = true; }
    }
  }
  return any ? data : null;
}

function rasterizeReliefs(N) {
  // Adaptive raster resolution: keep the subpixel near the nozzle width
  // (~0.42 mm) instead of a fixed 6/cell — at difficulty 1 a 48×48 grid
  // turns letters (and halftone dots) to mush. Capped so the face raster
  // stays ≤ 192².
  const cExp = state.autoEdge ? state.maxCell : (state.baseEdge * state.scale) / N;
  TEXT_SUB = Math.max(6, Math.min(Math.floor(cExp / 0.42), Math.floor(192 / N)));
  const SUB = TEXT_SUB, NS = N * SUB;
  const out = {};
  for (const [face, cfg] of Object.entries(state.texts)) {
    const data = cfg.mode === 'image'
      ? rasterizeImageFace(face, cfg, NS, SUB)
      : rasterizeTextFace(cfg, NS, SUB);
    if (data) out[face] = { data, style: cfg.s === 'emb' ? 'emb' : 'eng' };
  }
  return Object.keys(out).length ? out : null;
}

/* Uploaded images are downscaled and re-encoded to keep the share link a
   reasonable length — the final mesh is a coarse binary relief anyway, so
   source fidelity beyond a few hundred pixels buys nothing. A white
   backdrop (not canvas' default transparent-black) means a transparent
   PNG's background reads as "no mark", matching what a logo/silhouette
   upload would expect. */
const IMG_DIM_STEPS = [320, 256, 208, 168, 136, 112];
const IMG_Q_STEPS = [0.75, 0.6, 0.48, 0.38];
const IMG_B64_CAP = 24000; // ≈18 KB binary — keeps share links pasteable

function compressImageToB64(el) {
  const ar = (el.naturalWidth || 1) / (el.naturalHeight || 1);
  const draw = dim => {
    const w = ar >= 1 ? dim : Math.round(dim * ar);
    const h = ar >= 1 ? Math.round(dim / ar) : dim;
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(el, 0, 0, w, h);
    return cv;
  };
  for (const dim of IMG_DIM_STEPS) {
    const cv = draw(dim);
    for (const q of IMG_Q_STEPS) {
      const durl = cv.toDataURL('image/jpeg', q);
      const b64 = durl.slice(durl.indexOf(',') + 1);
      if (b64.length <= IMG_B64_CAP) return b64;
    }
  }
  const durl = draw(IMG_DIM_STEPS[IMG_DIM_STEPS.length - 1]).toDataURL('image/jpeg', 0.32);
  return durl.slice(durl.indexOf(',') + 1);
}

function loadImageFile(face, file) {
  if (!file || !file.type.startsWith('image/')) return;
  const reader = new FileReader();
  reader.onload = () => {
    const probe = new Image();
    probe.onload = () => {
      const b64 = compressImageToB64(probe);
      const prev = state.texts[face] || {};
      state.texts[face] = {
        mode: 'image', img: b64,
        h: prev.h || 'c', v: prev.v || 'm', s: prev.s || 'eng',
        scale: prev.scale ?? 0.85, dither: prev.dither ?? true, invert: prev.invert ?? false,
      };
      loadTextUI();
      regenerate();
    };
    probe.src = reader.result;
  };
  reader.readAsDataURL(file);
}

// Standard base64 → base64url (no padding): keeps the share link free of
// %2B/%2F/%3D escapes so it stays short and pasteable.
const toB64Url = s => s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64Url = s => {
  let t = s.replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  return t;
};

/* ---------- Shareable quest link (URL hash) ---------- */
function stateToHash() {
  const p = new URLSearchParams();
  p.set('d', state.difficulty);
  p.set('c', state.colors);
  p.set('k', state.scale);
  p.set('o', state.orient);
  p.set('m', state.maxCell);
  p.set('seed', state.seed);
  if (!state.autoEdge) p.set('e', state.baseEdge);
  if (state.hintCube && state.colors === 4) {
    p.set('hc', state.hintEdge);
    if (state.hintFrame) p.set('hcf', '1');
  }
  if (state.palette.join() !== DEFAULT_PALETTE.join())
    p.set('pal', state.palette.map(x => x.replace('#', '')).join('.'));
  for (const [face, cfg] of Object.entries(state.texts)) {
    if (cfg.mode === 'image' && cfg.img) {
      p.set('x' + face, ['img', cfg.s, cfg.h, cfg.v,
        Math.round((cfg.scale ?? 0.85) * 100), cfg.dither === false ? 0 : 1, cfg.invert ? 1 : 0,
        toB64Url(cfg.img)].join('.'));
    } else if ((cfg.t || '').trim()) {
      p.set('x' + face, [cfg.s, cfg.h, cfg.v, cfg.f || 'f0', cfg.t].join('.'));
    }
  }
  if (document.body.classList.contains('debug')) p.set('dbg', '1');
  return p.toString();
}

function applyHash() {
  const h = location.hash.replace(/^#/, '');
  if (!h) return false;
  const p = new URLSearchParams(h);
  const int = (v, lo, hi, dflt) => {
    const n = parseInt(v, 10);
    return isNaN(n) ? dflt : Math.min(hi, Math.max(lo, n));
  };
  if (p.has('d')) state.difficulty = int(p.get('d'), 1, 4, state.difficulty);
  if (p.has('c')) state.colors = p.get('c') === '1' ? 1 : 4;
  if (p.has('k')) state.scale = int(p.get('k'), 1, 3, state.scale);
  if (p.has('o')) state.orient = p.get('o') === 'tilt' ? 'tilt' : 'flat';
  if (p.has('m')) state.maxCell = int(p.get('m'), 1, 30, state.maxCell);
  if (p.has('seed')) state.seed = (p.get('seed') || state.seed).slice(0, 64);
  if (p.has('e')) {
    state.autoEdge = false;
    state.baseEdge = int(p.get('e'), 24, 400, state.baseEdge);
  } else {
    state.autoEdge = true;
  }
  state.hintCube = p.has('hc');
  if (p.has('hc')) state.hintEdge = int(p.get('hc'), 20, 80, state.hintEdge);
  state.hintFrame = p.get('hcf') === '1';
  if (p.has('pal')) {
    const parts = p.get('pal').split('.');
    if (parts.length === 4 && parts.every(x => /^[0-9a-fA-F]{6}$/.test(x)))
      state.palette = parts.map(x => '#' + x.toLowerCase());
  }
  state.texts = {};
  for (const f of ['F', 'R', 'B', 'L', 'T', 'Bo']) {
    const raw = p.get('x' + f);
    if (!raw) continue;
    const seg = raw.split('.');
    if (seg[0] === 'img') {
      if (seg.length < 8) continue;
      const s = seg[1] === 'emb' ? 'emb' : 'eng';
      const h = ['l', 'c', 'r'].includes(seg[2]) ? seg[2] : 'c';
      const v = ['t', 'm', 'b'].includes(seg[3]) ? seg[3] : 'm';
      const scale = Math.min(100, Math.max(10, parseInt(seg[4], 10) || 85)) / 100;
      const dither = seg[5] !== '0';
      const invert = seg[6] === '1';
      const b64 = fromB64Url(seg.slice(7).join('.'));
      if (b64) state.texts[f] = { mode: 'image', s, h, v, scale, dither, invert, img: b64 };
      continue;
    }
    if (seg.length < 4) continue;
    const s = seg[0] === 'emb' ? 'emb' : 'eng';
    const h = ['l', 'c', 'r'].includes(seg[1]) ? seg[1] : 'c';
    const v = ['t', 'm', 'b'].includes(seg[2]) ? seg[2] : 'm';
    // new links carry the font as the 4th field; old ones start text there
    const hasFont = seg.length >= 5 && /^f[0-3]$/.test(seg[3]);
    const fnt = hasFont ? seg[3] : 'f0';
    const txt = seg.slice(hasFont ? 4 : 3).join('.').slice(0, 200);
    if (txt.trim()) state.texts[f] = { mode: 'text', t: txt, h, v, s, f: fnt };
  }
  if (p.get('dbg') === '1') document.body.classList.add('debug');
  return true;
}

const syncSeg = (rootSel, val) =>
  $$(rootSel + ' button').forEach(b => b.classList.toggle('on', b.dataset.v === String(val)));

// Sync all controls to the current state (after loading a shared link)
function syncUI() {
  syncSeg('#seg-difficulty', state.difficulty);
  syncSeg('#seg-colors', state.colors);
  syncSeg('#seg-scale', state.scale);
  syncSeg('#seg-orient', state.orient);
  $('#chk-auto').checked = state.autoEdge;
  if (!state.autoEdge) $('#inp-edge').value = state.baseEdge;
  $('#inp-maxcell').value = state.maxCell;
  $('#inp-seed').value = state.seed;
  $('#chk-hint').checked = state.hintCube;
  $('#inp-hint').value = state.hintEdge;
  $('#chk-hint-frame').checked = state.hintFrame;
  $$('#color-pickers input').forEach((inp, k) => { inp.value = state.palette[k]; });
  loadTextUI();
}

/* ---------- Face text/image controls ---------- */
let curTextFace = 'F';
let curMode = 'text'; // which panel is shown — independent of committed content
const textCfg = f => state.texts[f] || { t: '', h: 'c', v: 'm', s: 'eng', f: 'f0' };
function loadTextUI() {
  const cfg = state.texts[curTextFace];
  curMode = (cfg && cfg.mode === 'image') ? 'image' : 'text';
  syncSeg('#seg-content', curMode);
  $('#mode-text').style.display = curMode === 'text' ? '' : 'none';
  $('#mode-image').style.display = curMode === 'image' ? '' : 'none';

  const tc = textCfg(curTextFace);
  $('#inp-text').value = tc.t || '';
  syncSeg('#seg-textface', curTextFace);
  syncSeg('#seg-th', tc.h);
  syncSeg('#seg-tv', tc.v);
  syncSeg('#seg-ts', tc.s);
  syncSeg('#seg-tf', tc.f || 'f0');

  const thumb = $('#img-thumb');
  if (cfg && cfg.mode === 'image' && cfg.img) {
    thumb.src = 'data:image/jpeg;base64,' + cfg.img;
    thumb.classList.add('has');
  } else {
    thumb.removeAttribute('src');
    thumb.classList.remove('has');
  }
  $('#chk-dither').checked = cfg ? (cfg.dither ?? true) : true;
  $('#chk-invert').checked = cfg ? (cfg.invert ?? false) : false;
  const scalePct = Math.round((cfg && cfg.scale != null ? cfg.scale : 0.85) * 100);
  $('#rng-scale').value = scalePct;
  $('#img-scale-val').textContent = scalePct + '%';

  // отметка граней с содержимым (текст или изображение)
  $$('#seg-textface button').forEach(b => {
    const c = state.texts[b.dataset.v];
    b.classList.toggle('has', !!(c && (c.mode === 'image' ? c.img : c.t)));
  });
}
function saveTextUI() {
  const cur = state.texts[curTextFace];
  const pick = sel => ($(sel + ' button.on') || $(sel + ' button')).dataset.v;
  if (cur && cur.mode === 'image') {
    cur.h = pick('#seg-th'); cur.v = pick('#seg-tv'); cur.s = pick('#seg-ts');
    cur.dither = $('#chk-dither').checked;
    cur.invert = $('#chk-invert').checked;
    cur.scale = (parseInt($('#rng-scale').value, 10) || 85) / 100;
  } else {
    const t2 = $('#inp-text').value.replace(/\r/g, '').slice(0, 200);
    if (t2.trim()) {
      state.texts[curTextFace] = { mode: 'text', t: t2, h: pick('#seg-th'), v: pick('#seg-tv'), s: pick('#seg-ts'), f: pick('#seg-tf') };
    } else {
      delete state.texts[curTextFace];
    }
  }
  loadTextUI();
  regenerate();
}

let model = null;
let plates = [];
let overflowCount = 0;
let misfit = false;

const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];

function fmt(n, d = 1) {
  return Number(n.toFixed(d)).toLocaleString(I18N_LOCALES[currentLang] || 'en-US');
}

// The cutting does not depend on the cube size — build it once (with a
// 1 mm cell) and scale the outlines to the requested edge length.
function scaledModel(base, L) {
  const c = L / base.N;
  const faces = base.faces.map(f => ({ name: f.name, pieces: [] }));
  const byName = Object.fromEntries(faces.map(f => [f.name, f]));
  const pieces = base.pieces.map(p => {
    const piece = { ...p, poly: p.poly.map(q => [q[0] * c, q[1] * c]) };
    byName[p.face].pieces.push(piece);
    return piece;
  });
  return { ...base, L, c, t: c, faces, pieces };
}

function layoutFor(m) {
  return layoutPlates(m, {
    colors: state.colors,
    plateCount: state.scale,
    bedW: state.bedW,
    bedH: state.bedH,
    clearance: state.orient === 'tilt' ? state.tiltClearance : 0,
    tilt: state.orient === 'tilt',
  });
}

// Largest cube edge at which everything fits the planned number of plates,
// with the cell capped at state.maxCell (bigger cells print much longer).
// The edge is quantized so that the cell (= thickness) is a multiple of 0.25 mm.
function findMaxEdge(base) {
  const N = base.N;
  const quant = L => Math.floor(L / N / 0.25) * 0.25 * N;
  const fits = L => {
    const res = layoutFor(scaledModel(base, L));
    return res.overflowCount === 0 && !res.misfit;
  };
  const cap = Math.max(24, quant(state.maxCell * N)); // cell ≤ maxCell
  let lo = 24, hi = Math.max(24, Math.min(480, cap));
  if (!fits(lo)) return lo;
  if (fits(hi)) return hi;
  while (hi - lo > 1) {
    const mid = Math.round((lo + hi) / 2);
    if (fits(mid)) lo = mid; else hi = mid;
  }
  return Math.max(24, Math.min(cap, quant(lo)));
}

function regenerate() {
  const base = buildPuzzle({
    difficulty: state.difficulty,
    colors: state.colors,
    L: 8 * state.difficulty, // 1 mm cell — the base geometry
    seed: state.seed,
    textMasks: rasterizeReliefs(8 * state.difficulty),
  });
  const L = state.autoEdge ? findMaxEdge(base) : state.baseEdge * state.scale;
  model = scaledModel(base, L);
  const res = layoutFor(model);
  plates = res.plates;
  overflowCount = res.overflowCount;
  misfit = res.misfit;
  const edgeInp = $('#inp-edge');
  edgeInp.disabled = state.autoEdge;
  if (state.autoEdge) edgeInp.value = L;
  history.replaceState(null, '', '#' + stateToHash()); // shareable quest link
  renderAll();
}

/* ---------- Rendering ---------- */
function renderAll() {
  renderStats();
  renderWarnings();
  drawNet($('#net-canvas'), model, state.palette, state.colors);
  renderPlates();
  renderFiles();
  if ($('#view-hint').style.display !== 'none' && hintEnabled())
    drawHint($('#hint-canvas'), model, state.palette, state.hintEdge, state.hintFrame);
}

function renderStats() {
  const count = model.pieces.length;
  $('#stat-pieces').textContent = count;
  $('#stat-perface').textContent = count / 6;
  $('#stat-edge').textContent = fmt(model.L, 0) + ' ' + t('mm');
  $('#stat-seed').textContent = state.seed;
  $('#stat-cell').textContent = `${fmt(model.c * 8, 1)}×${fmt(model.c * 4, 1)} ${t('mm')}`;
  $('#stat-thick').textContent = fmt(model.c, 2) + ' ' + t('mm');
  $('#stat-unique').textContent = model.unique ? '✓' : '—';
  $('#stat-plates').textContent = plates.length;
  const planned = state.scale * (state.colors === 4 ? 4 : 1);
  $('#stat-plates-note').textContent = plates.length > planned ? `${t('planned')} ${planned}` : '';
}

function renderWarnings() {
  const box = $('#warnings');
  const msgs = [];
  if (misfit) msgs.push(t('w_misfit', state.bedW, state.bedH));
  if (overflowCount > 0) msgs.push(t('w_overflow', overflowCount));
  if (model.c < 2.5) msgs.push(t('w_cell', fmt(model.c, 2)));
  if (!model.unique) msgs.push(t('w_unique'));
  box.innerHTML = msgs.map(m => `<div class="warn">▲ ${m}</div>`).join('');
  box.style.display = msgs.length ? 'block' : 'none';
}

function plateLabel(pl) {
  const colorPart = pl.color === null ? '' : `${t('color')} ${pl.color + 1} · `;
  return `${colorPart}${t('plate')} ${pl.index + 1}${pl.overflow ? ' ' + t('extra') : ''}`;
}
function plateFileName(pl) {
  const d = state.difficulty, k = state.scale;
  const c = pl.color === null ? '' : `_${COLOR_NAMES[pl.color]}`;
  return `cube_d${d}_${k}x${c}_plate${pl.index + 1}.stl`;
}

function renderPlates() {
  const wrap = $('#plates-grid');
  wrap.innerHTML = '';
  // as many cards per row as fit at ~260px each; the canvas fills the card
  const wrapW = wrap.getBoundingClientRect().width || 320;
  const perRow = Math.max(1, Math.min(plates.length, Math.floor(wrapW / 260)));
  const cardW = Math.max(200, Math.min(420, (wrapW - perRow * 20) / perRow));
  plates.forEach(pl => {
    const card = document.createElement('div');
    card.className = 'plate-card';
    const cv = document.createElement('canvas');
    card.appendChild(cv);
    const cap = document.createElement('div');
    cap.className = 'plate-cap';
    const sw = pl.color === null ? '' : `<i class="swatch" style="background:${state.palette[pl.color]}"></i>`;
    cap.innerHTML = `${sw}<span>${plateLabel(pl)}</span><em>${pl.pieces.length}</em>`;
    card.appendChild(cap);
    wrap.appendChild(card);
    drawPlate(cv, pl, model.c, state.palette, state.colors, cardW);
  });
}

const hintEnabled = () => state.hintCube && state.colors === 4;
function hintFileName(k) { // k = 0..3 color index, null = core body
  const d = state.difficulty;
  return k === null ? `cube_d${d}_hint_core.stl` : `cube_d${d}_hint_${COLOR_NAMES[k]}.stl`;
}
const hint3MFName = () => `cube_d${state.difficulty}_hint.3mf`;

function renderFiles() {
  const list = $('#file-list');
  list.innerHTML = '';
  const addRow = (swHtml, name, note, onDl, label = 'STL ↓') => {
    const row = document.createElement('div');
    row.className = 'file-row';
    row.innerHTML = `${swHtml}<code>${name}</code><span>${note}</span>`;
    const btn = document.createElement('button');
    btn.className = 'dl-btn';
    btn.textContent = label;
    btn.addEventListener('click', onDl);
    row.appendChild(btn);
    list.appendChild(row);
  };
  plates.forEach(pl => {
    const sw = pl.color === null
      ? `<i class="swatch mono"></i>`
      : `<i class="swatch" style="background:${state.palette[pl.color]}"></i>`;
    addRow(sw, plateFileName(pl), `${pl.pieces.length} ${t('pcs')}`, () => downloadPlate(pl));
  });
  let count = plates.length;
  // the hint-cube option only makes sense for the 4-color puzzle
  $('#hint-row').style.display = state.colors === 4 ? '' : 'none';
  // the hint preview tab follows the checkbox; leaving the tab while it
  // is active falls back to the net view
  const tabHint = $('#tab-hint');
  tabHint.style.display = hintEnabled() ? '' : 'none';
  if (!hintEnabled() && tabHint.classList.contains('on'))
    $$('.tab').find(x => x.dataset.view === 'net').click();
  if (hintEnabled()) {
    // single-file 3MF first: one object, parts pre-assigned to filaments
    const sw3 = `<i class="swatch" style="background:conic-gradient(${state.palette[0]} 25%,${state.palette[1]} 0 50%,${state.palette[2]} 0 75%,${state.palette[3]} 0)"></i>`;
    addRow(sw3, hint3MFName(), t('hintTag'), () =>
      downloadBlob(new Blob([hint3MF(model, state.hintEdge, state.palette, state.hintFrame)], { type: 'model/3mf' }), hint3MFName()),
      '3MF ↓');
    count++;
    for (const hf of hintSTLs(model, state.hintEdge, state.hintFrame)) {
      const sw = hf.color === null
        ? `<i class="swatch mono"></i>`
        : `<i class="swatch" style="background:${state.palette[hf.color]}"></i>`;
      addRow(sw, hintFileName(hf.color), t('hintTag'),
        () => downloadBlob(new Blob([hf.buf], { type: 'model/stl' }), hintFileName(hf.color)));
      count++;
    }
  }
  $('#dl-count').textContent = count;
}

/* ---------- Downloads ---------- */
function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 3000);
}
function downloadPlate(pl) {
  const buf = plateSTL(pl, model);
  downloadBlob(new Blob([buf], { type: 'model/stl' }), plateFileName(pl));
}
function downloadAll() {
  const files = plates.map(pl => ({
    name: plateFileName(pl),
    data: new Uint8Array(plateSTL(pl, model)),
  }));
  if (hintEnabled()) {
    files.push({ name: hint3MFName(), data: hint3MF(model, state.hintEdge, state.palette, state.hintFrame) });
    for (const hf of hintSTLs(model, state.hintEdge, state.hintFrame)) {
      files.push({ name: hintFileName(hf.color), data: new Uint8Array(hf.buf) });
    }
  }
  const readme =
`${t('rm_title')}
================================
${t('difficulty')}: ${state.difficulty} (${model.pieces.length} ${t('stPieces')}, ${model.pieces.length / 6} ${t('stPerFace')})
${t('colors')}: ${state.colors}
${t('scale')}: ${state.scale}x · ${t('stEdge')}: ${model.L} ${t('mm')}
${t('rm_cell')}: ${model.c.toFixed(2)} ${t('mm')} · ${t('rm_element')}
Seed: ${state.seed}
${t('rm_unique')}: ${model.unique ? t('yes') : t('no')}

${state.orient === 'tilt' ? t('rm_tilt') : t('rm_print')}
${hintEnabled() ? t('rm_hint', state.hintEdge) + '\n' : ''}${t('rm_assembly')}
`;
  files.push({ name: 'README.txt', data: new TextEncoder().encode(readme) });
  const zipName = `puzzle-cube_d${state.difficulty}_${state.scale}x_${state.colors}col.zip`;
  downloadBlob(buildZip(files), zipName);
}

/* ---------- UI wiring ---------- */
function bindSegmented(rootSel, key, parse = Number, after = regenerate) {
  $$(rootSel + ' button').forEach(b => {
    b.addEventListener('click', () => {
      state[key] = parse(b.dataset.v);
      $$(rootSel + ' button').forEach(x => x.classList.toggle('on', x === b));
      after();
    });
  });
}
function bindNumber(sel, key, min, max) {
  const el = $(sel);
  el.value = state[key];
  el.addEventListener('change', () => {
    let v = parseFloat(el.value.replace(',', '.'));
    if (isNaN(v)) v = state[key];
    v = Math.min(max, Math.max(min, v));
    el.value = v;
    state[key] = v;
    regenerate();
  });
}

function randomSeed() {
  // The seed itself is free text — this is just a readable suggestion.
  const words = [
    'grid', 'axis', 'bolt', 'gear', 'node', 'flux', 'iron', 'volt',
    'prism', 'pixel', 'quark', 'delta', 'vertex', 'onyx', 'titan', 'nova',
    'zinc', 'cobalt', 'ridge', 'joint', 'notch', 'facet', 'octa', 'helix',
    'sigma', 'omega', 'pylon', 'rotor', 'servo', 'lathe', 'anvil', 'forge',
    'ingot', 'beam', 'strut', 'truss', 'shard', 'torus', 'krypt', 'lumen',
  ];
  const w = () => words[Math.floor(Math.random() * words.length)];
  let a = w(), b = w();
  while (b === a) b = w();
  return a + '-' + b + '-' + String(Math.floor(Math.random() * 9000) + 1000);
}

function init() {
  setLang(detectLang());
  if (new URLSearchParams(location.search).has('debug')) document.body.classList.add('debug');
  applyHash(); // restore a shared quest before wiring the controls
  const langSel = $('#lang-select');
  langSel.value = currentLang;
  langSel.addEventListener('change', () => {
    setLang(langSel.value);
    if (model) renderAll();
  });

  bindSegmented('#seg-difficulty', 'difficulty');
  bindSegmented('#seg-colors', 'colors');
  bindSegmented('#seg-scale', 'scale');
  bindSegmented('#seg-orient', 'orient', String);
  bindNumber('#inp-edge', 'baseEdge', 24, 400);
  const chkAuto = $('#chk-auto');
  chkAuto.checked = state.autoEdge;
  chkAuto.addEventListener('change', () => {
    state.autoEdge = chkAuto.checked;
    if (!state.autoEdge && model) {
      // keep the current size when switching to manual mode
      state.baseEdge = Math.min(400, Math.max(24, Math.round(model.L / state.scale)));
      $('#inp-edge').value = state.baseEdge;
    }
    regenerate();
  });
  bindNumber('#inp-maxcell', 'maxCell', 1, 30);

  const seedInp = $('#inp-seed');
  seedInp.value = state.seed;
  seedInp.addEventListener('change', () => { state.seed = seedInp.value || 'cube'; regenerate(); });
  $('#btn-reseed').addEventListener('click', () => {
    state.seed = randomSeed();
    seedInp.value = state.seed;
    regenerate();
  });

  $$('#color-pickers input').forEach((inp, k) => {
    inp.value = state.palette[k];
    inp.addEventListener('input', () => { state.palette[k] = inp.value; renderAll(); });
  });

  // face text/image controls
  $$('#seg-textface button').forEach(b => {
    b.addEventListener('click', () => { curTextFace = b.dataset.v; loadTextUI(); });
  });
  $$('#seg-content button').forEach(b => {
    b.addEventListener('click', () => {
      // switches which panel is shown; nothing is committed until the
      // user actually types text or picks an image
      curMode = b.dataset.v;
      syncSeg('#seg-content', curMode);
      $('#mode-text').style.display = curMode === 'text' ? '' : 'none';
      $('#mode-image').style.display = curMode === 'image' ? '' : 'none';
    });
  });
  let textTimer = null;
  $('#inp-text').addEventListener('input', () => {
    clearTimeout(textTimer);
    textTimer = setTimeout(saveTextUI, 450);
  });
  for (const sel of ['#seg-th', '#seg-tv', '#seg-ts', '#seg-tf']) {
    $$(sel + ' button').forEach(b => {
      b.addEventListener('click', () => {
        $$(sel + ' button').forEach(x => x.classList.toggle('on', x === b));
        saveTextUI();
      });
    });
  }

  $('#inp-image').addEventListener('change', e => {
    const file = e.target.files && e.target.files[0];
    if (file) loadImageFile(curTextFace, file);
    e.target.value = ''; // allow re-picking the same file later
  });
  $('#btn-image-clear').addEventListener('click', () => {
    delete state.texts[curTextFace];
    loadTextUI();
    regenerate();
  });
  $('#chk-dither').addEventListener('change', saveTextUI);
  $('#chk-invert').addEventListener('change', saveTextUI);
  let scaleTimer = null;
  $('#rng-scale').addEventListener('input', () => {
    $('#img-scale-val').textContent = $('#rng-scale').value + '%';
    clearTimeout(scaleTimer);
    scaleTimer = setTimeout(saveTextUI, 200);
  });

  // hint cube: no model rebuild needed — just the hash, files and preview
  const hintChanged = () => {
    history.replaceState(null, '', '#' + stateToHash());
    renderFiles();
    if ($('#view-hint').style.display !== 'none' && hintEnabled())
      drawHint($('#hint-canvas'), model, state.palette, state.hintEdge, state.hintFrame);
  };
  $('#chk-hint').addEventListener('change', () => {
    state.hintCube = $('#chk-hint').checked;
    hintChanged();
  });
  $('#chk-hint-frame').addEventListener('change', () => {
    state.hintFrame = $('#chk-hint-frame').checked;
    hintChanged();
  });
  $('#inp-hint').addEventListener('change', () => {
    let v = parseFloat($('#inp-hint').value.replace(',', '.'));
    if (isNaN(v)) v = state.hintEdge;
    v = Math.min(80, Math.max(20, Math.round(v)));
    $('#inp-hint').value = v;
    state.hintEdge = v;
    hintChanged();
  });

  $('#btn-zip').addEventListener('click', downloadAll);

  // share: copy the quest link to the clipboard
  const shareBtn = $('#btn-share');
  shareBtn.addEventListener('click', async () => {
    const url = location.origin + location.pathname + location.search + '#' + stateToHash();
    history.replaceState(null, '', '#' + stateToHash());
    try { await navigator.clipboard.writeText(url); } catch (e) { /* clipboard unavailable */ }
    shareBtn.textContent = '✓';
    setTimeout(() => { shareBtn.textContent = '🔗'; }, 1200);
  });

  // a manually edited / navigated hash loads that quest
  window.addEventListener('hashchange', () => {
    if (applyHash()) { syncUI(); regenerate(); }
  });

  // preview tabs (re-render after showing: a hidden container has zero width)
  $$('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach(x => x.classList.toggle('on', x === tab));
      const view = tab.dataset.view;
      $('#view-net').style.display = view === 'net' ? 'block' : 'none';
      $('#view-plates').style.display = view === 'plates' ? 'block' : 'none';
      $('#view-hint').style.display = view === 'hint' ? 'block' : 'none';
      const bar = $('.statbar');
      bar.classList.toggle('mode-net', view === 'net');
      bar.classList.toggle('mode-plates', view === 'plates');
      bar.classList.toggle('mode-hint', view === 'hint');
      if (!model) return;
      if (view === 'net') drawNet($('#net-canvas'), model, state.palette, state.colors);
      else if (view === 'plates') renderPlates();
      else drawHint($('#hint-canvas'), model, state.palette, state.hintEdge, state.hintFrame);
    });
  });

  // debounced: mobile browsers fire resize on address-bar show/hide
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (model) renderAll(); }, 150);
  });
  syncUI();
  regenerate();
}

document.addEventListener('DOMContentLoaded', init);
