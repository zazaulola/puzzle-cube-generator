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
  // hidden hemisphere fixators: dot = bump, ring = socket, on a separate
  // overlay canvas — CSS keeps it hidden unless body.debug is set
  const fixCv = document.getElementById('net-fix');
  if (fixCv) {
    const fctx = setupCanvas(fixCv, cssW, cssH);
    fctx.clearRect(0, 0, cssW, cssH);
    const rDot = Math.max(1.2, FIX_R * model.c * s * 0.9);
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
