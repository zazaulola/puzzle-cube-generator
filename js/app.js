'use strict';
/* ============================================================
   app.js — state, UI wiring, file export
   ============================================================ */

const COLOR_NAMES = ['c1', 'c2', 'c3', 'c4'];
const state = {
  difficulty: 2,
  colors: 4,
  scale: 1,
  autoEdge: true,   // pick the largest cube edge that fits the plates
  baseEdge: 80,     // cube edge at 1x (manual mode), mm
  maxCell: 4,       // cap on the cell size in auto mode, mm (print time!)
  clearance: 0,     // clearance per side, mm (fixed; tune fit in the slicer)
  bedW: 256,        // print plate size, mm (fixed)
  bedH: 256,
  seed: 'cube-001',
  palette: ['#e8543f', '#f4b942', '#3e9e6e', '#3d7dd8'],
};

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
    clearance: state.clearance,
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
  const cardW = Math.max(220, Math.min(300, (wrap.getBoundingClientRect().width - 40) / Math.min(plates.length, 3)));
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
  const buf = plateSTL(pl, model.c);
  downloadBlob(new Blob([buf], { type: 'model/stl' }), plateFileName(pl));
}
function downloadAll() {
  const files = plates.map(pl => ({
    name: plateFileName(pl),
    data: new Uint8Array(plateSTL(pl, model.c)),
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

${t('rm_print')}
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
  const words = ['grid', 'axis', 'bolt', 'gear', 'node', 'flux', 'iron', 'volt'];
  return words[Math.floor(Math.random() * words.length)] + '-' +
    String(Math.floor(Math.random() * 900) + 100);
}

function init() {
  setLang(detectLang());
  const langSel = $('#lang-select');
  langSel.value = currentLang;
  langSel.addEventListener('change', () => {
    setLang(langSel.value);
    if (model) renderAll();
  });

  bindSegmented('#seg-difficulty', 'difficulty');
  bindSegmented('#seg-colors', 'colors');
  bindSegmented('#seg-scale', 'scale');
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

  // preview tabs (re-render after showing: a hidden container has zero width)
  $$('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach(x => x.classList.toggle('on', x === tab));
      const isNet = tab.dataset.view === 'net';
      $('#view-net').style.display = isNet ? 'block' : 'none';
      $('#view-plates').style.display = isNet ? 'none' : 'block';
      if (!model) return;
      if (isNet) drawNet($('#net-canvas'), model, state.palette, state.colors);
      else renderPlates();
    });
  });

  window.addEventListener('resize', () => renderAll());
  regenerate();
}

document.addEventListener('DOMContentLoaded', init);
