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
  palette: [...DEFAULT_PALETTE],
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
  if (state.palette.join() !== DEFAULT_PALETTE.join())
    p.set('pal', state.palette.map(x => x.replace('#', '')).join('.'));
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
  if (p.has('pal')) {
    const parts = p.get('pal').split('.');
    if (parts.length === 4 && parts.every(x => /^[0-9a-fA-F]{6}$/.test(x)))
      state.palette = parts.map(x => '#' + x.toLowerCase());
  }
  if (p.get('dbg') === '1') document.body.classList.add('debug');
  return true;
}

// Sync all controls to the current state (after loading a shared link)
function syncUI() {
  const syncSeg = (rootSel, val) =>
    $$(rootSel + ' button').forEach(b => b.classList.toggle('on', b.dataset.v === String(val)));
  syncSeg('#seg-difficulty', state.difficulty);
  syncSeg('#seg-colors', state.colors);
  syncSeg('#seg-scale', state.scale);
  syncSeg('#seg-orient', state.orient);
  $('#chk-auto').checked = state.autoEdge;
  if (!state.autoEdge) $('#inp-edge').value = state.baseEdge;
  $('#inp-maxcell').value = state.maxCell;
  $('#inp-seed').value = state.seed;
  $$('#color-pickers input').forEach((inp, k) => { inp.value = state.palette[k]; });
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

function renderFiles() {
  const list = $('#file-list');
  list.innerHTML = '';
  plates.forEach(pl => {
    const row = document.createElement('div');
    row.className = 'file-row';
    const sw = pl.color === null
      ? `<i class="swatch mono"></i>`
      : `<i class="swatch" style="background:${state.palette[pl.color]}"></i>`;
    row.innerHTML = `${sw}<code>${plateFileName(pl)}</code><span>${pl.pieces.length} ${t('pcs')}</span>`;
    const btn = document.createElement('button');
    btn.className = 'dl-btn';
    btn.textContent = 'STL ↓';
    btn.addEventListener('click', () => downloadPlate(pl));
    row.appendChild(btn);
    list.appendChild(row);
  });
  $('#dl-count').textContent = plates.length;
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
${t('rm_assembly')}
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
      const isNet = tab.dataset.view === 'net';
      $('#view-net').style.display = isNet ? 'block' : 'none';
      $('#view-plates').style.display = isNet ? 'none' : 'block';
      const bar = $('.statbar');
      bar.classList.toggle('mode-net', isNet);
      bar.classList.toggle('mode-plates', !isNet);
      if (!model) return;
      if (isNet) drawNet($('#net-canvas'), model, state.palette, state.colors);
      else renderPlates();
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
