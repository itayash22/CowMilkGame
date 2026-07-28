'use strict';
/* Focus Presenter — single-file, offline presentation focus tool.
   Content model: pages (PDF pages or images) stacked vertically in "doc units"
   (PDF CSS units at scale 1 / image pixels). Everything on screen is doc units
   × zoom. Slates and the spotlight live in doc units too, so they stay glued
   to the content across scroll and zoom.

   Resolution: PDF pages are vector, so tiles are re-rendered from source at
   (zoom × devicePixelRatio) whenever zoom changes — never bitmap-stretched.
   Tall pages are sliced into tiles to stay under browser canvas size limits,
   and tiles render lazily near the visible area with far-away eviction, so
   very long exported flow charts stay sharp and memory stays bounded. */

/* Two build targets share this file:
   - single-file build: the worker source is inlined in a text/plain tag → blob URL
   - MV3 extension build: no inline scripts allowed → load the worker as a packaged file */
const workerTag = document.getElementById('pdf-worker-code');
pdfjsLib.GlobalWorkerOptions.workerSrc = workerTag
  ? URL.createObjectURL(new Blob([workerTag.textContent], { type: 'text/javascript' }))
  : 'vendor/pdf.worker.min.js';

const $ = s => document.querySelector(s);
const vp = $('#viewport'), doc = $('#doc'), overlay = $('#overlay');

const GAP = 18;            // gap between pages, doc units
const TILE = 1000;         // tile height, doc units
const MAXTEX = 8192;       // max canvas backing dimension (safe across browsers)
const MINZ = 0.05, MAXZ = 16;

const state = {
  zoom: 1, dpr: Math.max(1, window.devicePixelRatio || 1),
  pdf: null, pages: [], docW: 0, docH: 0,
  slates: [], sel: null, spot: null,
  style: 'paper', shade: 1, uid: 0, tear: false,
  steps: [], stepIdx: -1, stepsOn: false, docType: null, preview: null,
  src: null, audience: false, voiceHold: false, voiceFree: false,
};

/* ---------------- helpers ---------------- */

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

let toastT;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms);
}

function hasDoc() { return state.pages.length > 0; }

/* ---------------- document loading ---------------- */

function resetDoc() {
  if (state.pdf) { state.pdf.destroy(); state.pdf = null; }
  for (const p of state.pages) p.el.remove();
  state.pages = []; state.docW = state.docH = 0;
  killAllShades(true);
}

async function openPDF(buf, name) {
  toast('Opening ' + name + '…');
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  resetDoc();
  state.pdf = pdf;
  for (let i = 1; i <= pdf.numPages; i++) {
    const pp = await pdf.getPage(i);
    const v = pp.getViewport({ scale: 1 });
    addPage({ kind: 'pdf', pdfPage: pp, w: v.width, h: v.height });
  }
  finishOpen(name + ' — ' + pdf.numPages + (pdf.numPages > 1 ? ' pages' : ' page'));
}

function openImages(files) {
  let pending = files.length;
  const slots = files.map(() => null);
  files.forEach((f, i) => {
    const url = URL.createObjectURL(f);
    const img = new Image();
    img.onload = () => {
      slots[i] = { kind: 'img', url, w: img.naturalWidth, h: img.naturalHeight };
      if (--pending === 0) {
        for (const s of slots) if (s) addPage(s);
        finishOpen(files.length + ' image' + (files.length > 1 ? 's' : '') + ' added');
      }
    };
    img.onerror = () => { if (--pending === 0) finishOpen('Images added'); };
    img.src = url;
  });
}

function addPage(p) {
  const el = document.createElement('div');
  el.className = 'page';
  p.el = el;
  if (p.kind === 'pdf') {
    p.tiles = [];
    for (let y = 0; y < p.h; y += TILE) {
      const c = document.createElement('canvas');
      c.width = c.height = 0;
      el.appendChild(c);
      p.tiles.push({ y0: y, h: Math.min(TILE, p.h - y), canvas: c, done: 0, want: 0 });
    }
  } else {
    const img = new Image();
    img.src = p.url; img.draggable = false;
    el.appendChild(img);
  }
  doc.insertBefore(el, overlay);
  state.pages.push(p);
}

function finishOpen(msg) {
  state.docW = Math.max(...state.pages.map(p => p.w));
  let y = 0;
  for (const p of state.pages) { p.top = y; y += p.h + GAP; }
  state.docH = y - GAP;
  $('#empty').style.display = 'none';
  for (const id of ['bSlate', 'bCurtain', 'bSpot', 'bTear', 'bClear', 'bZi', 'bZo', 'bFit', 'bSteps', 'bPresent'])
    $('#' + id).disabled = false;
  if (SR) $('#bVoice').disabled = false;
  fitWidth();
  vp.scrollTop = 0; vp.scrollLeft = 0;
  scheduleRender();
  if (!state.audience) {
    toast(msg + ' — press S for a slate, C for a curtain, L for spotlight', 4200);
    detectSteps().then(() => {
      if (state.steps.length >= 2) setStepsOn(true);
    }).catch(e => console.error('detect', e));
  }
}

/* ---------------- layout & zoom ---------------- */

function layout() {
  const z = state.zoom;
  doc.style.width = state.docW * z + 'px';
  doc.style.height = state.docH * z + 'px';
  for (const p of state.pages) {
    const s = p.el.style;
    s.top = p.top * z + 'px';
    s.left = (state.docW - p.w) / 2 * z + 'px';
    s.width = p.w * z + 'px';
    s.height = p.h * z + 'px';
    if (p.tiles) for (const t of p.tiles) {
      const cs = t.canvas.style;
      cs.top = t.y0 * z + 'px';
      cs.width = p.w * z + 'px';
      cs.height = t.h * z + 'px';
    }
  }
  for (const sl of state.slates) placeRect(sl);
  if (state.spot) placeRect(state.spot);
  $('#zpct').textContent = Math.round(z * 100) + '%';
}

function placeRect(r) {
  const z = state.zoom, s = r.el.style;
  s.left = r.x * z + 'px'; s.top = r.y * z + 'px';
  s.width = r.w * z + 'px'; s.height = r.h * z + 'px';
  if (r.holes) {
    for (const h of r.holes) placeHole(h);
    updateMask(r);
  }
}

function placeHole(h) {
  const z = state.zoom, s = h.el.style;
  s.left = h.x * z + 'px'; s.top = h.y * z + 'px';
  s.width = h.w * z + 'px'; s.height = h.h * z + 'px';
}

/* cut the holes out of the slate's sheet with an SVG alpha mask (evenodd) */
function updateMask(sl) {
  const st = sl.sheetEl.style;
  if (!sl.holes.length) {
    st.webkitMaskImage = st.maskImage = '';
    return;
  }
  let d = `M0 0H${sl.w}V${sl.h}H0Z`;
  for (const h of sl.holes) d += `M${h.x} ${h.y}h${h.w}v${h.h}h${-h.w}Z`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${sl.w} ${sl.h}" preserveAspectRatio="none"><path fill-rule="evenodd" fill="#fff" d="${d}"/></svg>`;
  const url = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  st.webkitMaskImage = st.maskImage = url;
  st.webkitMaskSize = st.maskSize = '100% 100%';
}

function setZoom(nz, ax, ay) {
  nz = clamp(nz, MINZ, MAXZ);
  const oz = state.zoom;
  if (nz === oz) return;
  ax = ax ?? vp.clientWidth / 2; ay = ay ?? vp.clientHeight / 2;
  const dx = (vp.scrollLeft + ax) / oz, dy = (vp.scrollTop + ay) / oz;
  state.zoom = nz;
  layout();
  vp.scrollLeft = dx * nz - ax;
  vp.scrollTop = dy * nz - ay;
  scheduleRender();
}

function fitWidth() {
  if (!hasDoc()) return;
  setZoom((vp.clientWidth - 36) / state.docW);
  layout(); scheduleRender();
}

/* ---------------- tile rendering ---------------- */

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; renderVisible(); });
}

function renderVisible() {
  if (!hasDoc()) return;
  const z = state.zoom;
  const vh = vp.clientHeight / z;
  const y0 = vp.scrollTop / z - vh, y1 = vp.scrollTop / z + 2 * vh;   // ±1 viewport of lookahead
  const evict0 = vp.scrollTop / z - 5 * vh, evict1 = vp.scrollTop / z + 6 * vh;
  for (const p of state.pages) {
    if (!p.tiles) continue;
    // sharpest scale that keeps the canvas under browser texture limits
    const eff = Math.min(z * state.dpr, MAXTEX / p.w, MAXTEX / TILE);
    for (const t of p.tiles) {
      const ty0 = p.top + t.y0, ty1 = ty0 + t.h;
      if (ty1 > y0 && ty0 < y1) {
        if (t.done !== eff) { t.want = eff; queueTile(p, t); }
      } else if (t.done && (ty1 < evict0 || ty0 > evict1)) {
        t.canvas.width = t.canvas.height = 0;   // free far-away bitmaps
        t.done = 0; t.want = 0;
      }
    }
  }
  pump();
}

const q = [];
let active = 0;
function queueTile(p, t) {
  if (t.queued || t.rendering) return;
  t.queued = true;
  q.push([p, t]);
}

function pump() {
  while (active < 2 && q.length) {
    const [p, t] = q.shift();
    t.queued = false;
    active++;
    renderTile(p, t);
  }
}

async function renderTile(p, t) {
  t.rendering = true;
  try {
    do {
      const s = t.want;
      const c = document.createElement('canvas');
      c.width = Math.round(p.w * s); c.height = Math.round(t.h * s);
      const ctx = c.getContext('2d', { alpha: false });
      // extra transform runs before the viewport transform, in device px:
      // shift the full-res page up so this tile's band lands on the canvas
      await p.pdfPage.render({
        canvasContext: ctx,
        viewport: p.pdfPage.getViewport({ scale: s }),
        transform: [1, 0, 0, 1, 0, -Math.round(t.y0 * s)],
        background: '#ffffff',
      }).promise;
      t.canvas.width = c.width; t.canvas.height = c.height;
      t.canvas.getContext('2d').drawImage(c, 0, 0);
      t.done = s;
    } while (t.want !== t.done);   // zoom changed mid-render → redo at new scale
  } catch (e) {
    if (!(e instanceof pdfjsLib.RenderingCancelledException)) console.error(e);
  } finally {
    t.rendering = false;
    active--;
    pump();
  }
}

/* ---------------- slates & spotlight ---------------- */

function viewCenter() {
  const z = state.zoom;
  return { x: (vp.scrollLeft + vp.clientWidth / 2) / z, y: (vp.scrollTop + vp.clientHeight / 2) / z };
}

function makeHandles(el) {
  for (const h of ['n', 's', 'w', 'e']) {
    const d = document.createElement('div');
    d.className = 'strip'; d.dataset.h = h; el.appendChild(d);
  }
  for (const h of ['nw', 'ne', 'sw', 'se', 'n', 's', 'w', 'e']) {
    const d = document.createElement('div');
    d.className = 'dot'; d.dataset.h = h; el.appendChild(d);
  }
}

function spawnSlate(rect) {
  const z = state.zoom, c = viewCenter();
  const r = rect || {
    w: vp.clientWidth * 0.5 / z, h: vp.clientHeight * 0.38 / z,
  };
  if (!rect) { r.x = c.x - r.w / 2; r.y = c.y - r.h / 2; }
  const sl = { id: ++state.uid, holes: [], ...r };
  const el = document.createElement('div');
  el.className = 'slate';
  const sheet = document.createElement('div');
  sheet.className = 'sheet ' + state.style;
  sheet.style.opacity = state.shade;
  el.appendChild(sheet);
  sl.sheetEl = sheet;
  const kill = document.createElement('button');
  kill.className = 'kill'; kill.textContent = '×'; kill.title = 'Kill this slate (Delete)';
  kill.addEventListener('click', e => { e.stopPropagation(); killSlate(sl); });
  el.appendChild(kill);
  makeHandles(el);
  sl.el = el;
  overlay.appendChild(el);
  dragify(sl);
  state.slates.push(sl);
  placeRect(sl);
  select(sl);
  return sl;
}

function spawnCurtain() {
  const z = state.zoom;
  const y = (vp.scrollTop + vp.clientHeight * 0.45) / z;
  const sl = spawnSlate({
    x: 0, y,
    w: state.docW,
    h: Math.max(state.docH - y, vp.clientHeight / z),
  });
  toast('Curtain down — drag its top edge to reveal the flow step by step');
  return sl;
}

function ensureSpot(quiet) {
  if (state.spot) return state.spot;
  const z = state.zoom, c = viewCenter();
  const sp = {
    id: 'spot',
    w: vp.clientWidth * 0.46 / z, h: vp.clientHeight * 0.36 / z,
  };
  sp.x = c.x - sp.w / 2; sp.y = c.y - sp.h / 2;
  const el = document.createElement('div');
  el.id = 'spot';
  makeHandles(el);
  sp.el = el;
  overlay.appendChild(el);
  dragify(sp);
  state.spot = sp;
  applyShade();
  placeRect(sp);
  if (!quiet) select(sp);
  $('#bSpot').classList.add('on');
  return sp;
}

function toggleSpot() {
  if (state.spot) { killSpot(); return; }
  ensureSpot();
  toast('Spotlight on — drag it along the flow; L turns it off');
}

function killSlate(sl) {
  sl.el.remove();
  state.slates = state.slates.filter(s => s !== sl);
  if (state.sel === sl) state.sel = null;
}

function killSpot() {
  if (!state.spot) return;
  state.spot.el.remove();
  state.spot = null;
  if (state.sel && state.sel.id === 'spot') state.sel = null;
  $('#bSpot').classList.remove('on');
}

function killAllShades(silent) {
  for (const sl of [...state.slates]) killSlate(sl);
  killSpot();
  if (!silent) toast('All slates cleared — S / C / L to spawn new ones');
}

function select(r) {
  if (state.sel) state.sel.el.classList.remove('sel');
  state.sel = r;
  if (r) r.el.classList.add('sel');
}

function applyShade() {
  for (const sl of state.slates) {
    sl.sheetEl.className = 'sheet ' + state.style;
    sl.sheetEl.style.opacity = state.shade;
  }
  if (state.spot)
    state.spot.el.style.boxShadow = '0 0 0 200000px rgba(8,10,15,' + (0.94 * state.shade).toFixed(3) + ')';
}

/* ---------------- tears (holes that let light through a slate) ---------------- */

function setTear(on) {
  state.tear = on;
  document.body.classList.toggle('tear', on);
  $('#bTear').classList.toggle('on', on);
}

function toggleTear() {
  setTear(!state.tear);
  if (state.tear && !state.slates.length)
    toast('Tear mode is on, but there is no slate yet — press S or C to spawn one first');
}

let tearHintShown = false;

function startTear(sl, e) {
  const z = state.zoom, box = sl.el.getBoundingClientRect();
  const x0 = clamp((e.clientX - box.left) / z, 0, sl.w);
  const y0 = clamp((e.clientY - box.top) / z, 0, sl.h);
  const rub = document.createElement('div');
  rub.className = 'rubber';
  sl.el.appendChild(rub);
  sl.el.setPointerCapture(e.pointerId);
  let cur = { x: x0, y: y0, w: 0, h: 0 };
  const move = ev => {
    const cx = clamp((ev.clientX - box.left) / z, 0, sl.w);
    const cy = clamp((ev.clientY - box.top) / z, 0, sl.h);
    cur = { x: Math.min(x0, cx), y: Math.min(y0, cy), w: Math.abs(cx - x0), h: Math.abs(cy - y0) };
    rub.style.left = cur.x * z + 'px'; rub.style.top = cur.y * z + 'px';
    rub.style.width = cur.w * z + 'px'; rub.style.height = cur.h * z + 'px';
  };
  const up = () => {
    sl.el.removeEventListener('pointermove', move);
    sl.el.removeEventListener('pointerup', up);
    sl.el.removeEventListener('pointercancel', up);
    rub.remove();
    if (cur.w > 8 && cur.h > 8) {
      addHole(sl, cur);
      if (!tearHintShown) {
        tearHintShown = true;
        toast('Torn open — light is in. Drag or resize the tear; seam it with its ⊕ or a click in tear mode');
      }
    }
  };
  sl.el.addEventListener('pointermove', move);
  sl.el.addEventListener('pointerup', up);
  sl.el.addEventListener('pointercancel', up);
}

function addHole(sl, r) {
  const h = { ...r };
  const el = document.createElement('div');
  el.className = 'hole';
  const seam = document.createElement('button');
  seam.className = 'seam'; seam.textContent = '⊕'; seam.title = 'Seam this tear closed';
  seam.addEventListener('click', e => { e.stopPropagation(); seamHole(sl, h); });
  el.appendChild(seam);
  for (const hd of ['nw', 'ne', 'sw', 'se']) {
    const d = document.createElement('div');
    d.className = 'dot'; d.dataset.h = hd; el.appendChild(d);
  }
  h.el = el;
  sl.el.appendChild(el);
  sl.holes.push(h);
  dragifyHole(sl, h);
  placeHole(h);
  updateMask(sl);
  return h;
}

function seamHole(sl, h) {
  h.el.remove();
  sl.holes = sl.holes.filter(x => x !== h);
  updateMask(sl);
}

function clampHoles(sl) {
  for (const h of sl.holes) {
    h.w = Math.min(h.w, sl.w); h.h = Math.min(h.h, sl.h);
    h.x = clamp(h.x, 0, sl.w - h.w); h.y = clamp(h.y, 0, sl.h - h.h);
  }
}

function dragifyHole(sl, h) {
  h.el.addEventListener('pointerdown', e => {
    if (e.target.classList.contains('seam')) { e.stopPropagation(); return; }
    e.preventDefault(); e.stopPropagation();
    if (state.tear) { seamHole(sl, h); return; }   // in tear mode a click seams it back
    select(sl);
    const hd = e.target.dataset.h || 'move';
    const z = state.zoom, sx = e.clientX, sy = e.clientY, o = { x: h.x, y: h.y, w: h.w, h: h.h };
    h.el.setPointerCapture(e.pointerId);
    const move = ev => {
      const dx = (ev.clientX - sx) / z, dy = (ev.clientY - sy) / z;
      if (hd === 'move') { h.x = o.x + dx; h.y = o.y + dy; }
      if (hd.includes('e')) h.w = Math.max(10, o.w + dx);
      if (hd.includes('s')) h.h = Math.max(10, o.h + dy);
      if (hd.includes('w')) { h.w = Math.max(10, o.w - dx); h.x = o.x + o.w - h.w; }
      if (hd.includes('n')) { h.h = Math.max(10, o.h - dy); h.y = o.y + o.h - h.h; }
      h.w = Math.min(h.w, sl.w); h.h = Math.min(h.h, sl.h);
      h.x = clamp(h.x, 0, sl.w - h.w); h.y = clamp(h.y, 0, sl.h - h.h);
      placeHole(h);
      updateMask(sl);
    };
    const up = () => {
      h.el.removeEventListener('pointermove', move);
      h.el.removeEventListener('pointerup', up);
      h.el.removeEventListener('pointercancel', up);
    };
    h.el.addEventListener('pointermove', move);
    h.el.addEventListener('pointerup', up);
    h.el.addEventListener('pointercancel', up);
  });
}

/* keep a nudged slate/spotlight on screen — the view follows it along the flow */
function ensureVisible(r) {
  const z = state.zoom, m = 48;
  const x0 = r.x * z, y0 = r.y * z, x1 = (r.x + r.w) * z, y1 = (r.y + r.h) * z;
  let st = vp.scrollTop, sl = vp.scrollLeft;
  if (y1 > st + vp.clientHeight - m) st = y1 - vp.clientHeight + m;
  if (y0 < st + m) st = y0 - m;
  if (x1 > sl + vp.clientWidth - m) sl = x1 - vp.clientWidth + m;
  if (x0 < sl + m) sl = x0 - m;
  vp.scrollTo({ top: st, left: sl, behavior: 'smooth' });
}

const MINSZ = 16; // doc units

function dragify(r) {
  r.el.addEventListener('pointerdown', e => {
    if (e.target.classList.contains('kill')) return;
    e.preventDefault(); e.stopPropagation();
    if (state.tear && r.holes) { startTear(r, e); return; }
    select(r);
    const h = e.target.dataset.h || 'move';
    const z = state.zoom, sx = e.clientX, sy = e.clientY, o = { x: r.x, y: r.y, w: r.w, h: r.h };
    r.el.setPointerCapture(e.pointerId);
    const move = ev => {
      const dx = (ev.clientX - sx) / z, dy = (ev.clientY - sy) / z;
      if (h === 'move') { r.x = o.x + dx; r.y = o.y + dy; }
      if (h.includes('e')) r.w = Math.max(MINSZ, o.w + dx);
      if (h.includes('s')) r.h = Math.max(MINSZ, o.h + dy);
      if (h.includes('w')) { r.w = Math.max(MINSZ, o.w - dx); r.x = o.x + o.w - r.w; }
      if (h.includes('n')) { r.h = Math.max(MINSZ, o.h - dy); r.y = o.y + o.h - r.h; }
      if (h !== 'move' && r.holes) clampHoles(r);
      placeRect(r);
    };
    const up = ev => {
      r.el.releasePointerCapture(e.pointerId);
      r.el.removeEventListener('pointermove', move);
      r.el.removeEventListener('pointerup', up);
      r.el.removeEventListener('pointercancel', up);
    };
    r.el.addEventListener('pointermove', move);
    r.el.addEventListener('pointerup', up);
    r.el.addEventListener('pointercancel', up);
  });
}

/* ---------------- terrain study: auto-detected spotlight steps ----------------
   The app studies the opened document and classifies it:
     flow chart  -> steps are the boxes/objects (clustered text)
     contract    -> steps are the numbered sections
     document    -> steps are paragraph bands
   Heuristics run on the pdf.js text layer, fully offline. Where Chrome's
   built-in on-device model is available (extension, Chrome 138+), it could
   refine this — the heuristics are the always-available baseline. */

async function detectSteps() {
  state.steps = []; state.docType = null; state.stepIdx = -1;
  if (!state.pdf) return;
  const pages = [];
  for (const p of state.pages) {
    if (p.kind !== 'pdf') continue;
    const tc = await p.pdfPage.getTextContent();
    const vpt = p.pdfPage.getViewport({ scale: 1 });
    const left = (state.docW - p.w) / 2;
    const items = [];
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const tr = pdfjsLib.Util.transform(vpt.transform, it.transform);
      const h = Math.hypot(tr[2], tr[3]) || 10;
      items.push({ str: it.str.trim(), x: left + tr[4], y: p.top + tr[5] - h,
                   w: it.width || h * it.str.length * 0.5, h });
    }
    pages.push({ p, items });
  }
  if (!pages.length) return;

  // group items into text lines (shared across classifiers)
  const linesOf = items => {
    const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
    const lines = [];
    for (const it of sorted) {
      const L = lines[lines.length - 1];
      if (L && Math.abs(it.y - L.y) < Math.max(4, L.h * 0.6)) {
        L.items.push(it);
        L.x0 = Math.min(L.x0, it.x); L.x1 = Math.max(L.x1, it.x + it.w);
        L.h = Math.max(L.h, it.h);
      } else lines.push({ y: it.y, h: it.h, x0: it.x, x1: it.x + it.w, items: [it] });
    }
    for (const L of lines) L.text = L.items.sort((a, b) => a.x - b.x).map(i => i.str).join(' ');
    return lines;
  };

  const SECTION = /^\s*(?:(\d+(?:\.\d+)+|\d+)[.)]?|§\s*(\d+(?:\.\d+)*)|(?:section|article|clause)\s+(\d+(?:\.\d+)*))\s+\S/i;
  const allLines = pages.flatMap(pg => linesOf(pg.items));
  const headings = allLines.filter(L => SECTION.test(L.text) && L.text.length < 160);
  // flow boxes are often numbered too ("1 Landing page") — call it a contract only
  // on strong legal signals: multi-level numbering (3.2.1) or section/clause keywords
  const strong = headings.filter(L => /^\s*\d+\.\d+/.test(L.text) || /^(?:\s*§|\s*(?:section|article|clause)\b)/i.test(L.text));

  if (strong.length >= 3) {
    // ---- contract / legal document: one step per numbered section
    state.docType = 'contract';
    headings.sort((a, b) => a.y - b.y);
    const x0 = Math.min(...allLines.map(L => L.x0)), x1 = Math.max(...allLines.map(L => L.x1));
    headings.forEach((H, i) => {
      const yEnd = i + 1 < headings.length ? headings[i + 1].y - 6 : Math.min(H.y + 600, state.docH);
      const m = H.text.match(SECTION);
      state.steps.push({
        x: x0, y: H.y - 4, w: x1 - x0, h: Math.max(yEnd - H.y, H.h + 8),
        label: H.text.slice(0, 80),
        section: (m[1] || m[2] || m[3] || '').replace(/\.$/, ''),
      });
    });
    return;
  }

  // ---- flow chart: cluster text items into boxes/objects
  for (const { p, items } of pages) {
    if (!items.length) continue;
    const GAPX = 18, GAPY = 12;
    const parent = items.map((_, i) => i);
    const find = i => parent[i] === i ? i : (parent[i] = find(parent[i]));
    for (let i = 0; i < items.length; i++)
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i], b = items[j];
        if (a.x < b.x + b.w + GAPX && b.x < a.x + a.w + GAPX &&
            a.y < b.y + b.h + GAPY && b.y < a.y + a.h + GAPY)
          parent[find(i)] = find(j);
      }
    const groups = new Map();
    items.forEach((it, i) => {
      const r = find(i);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(it);
    });
    for (const g of groups.values()) {
      const x0 = Math.min(...g.map(i => i.x)), x1 = Math.max(...g.map(i => i.x + i.w));
      const y0 = Math.min(...g.map(i => i.y)), y1 = Math.max(...g.map(i => i.y + i.h));
      if (x1 - x0 > p.w * 0.9) continue;   // page-wide banner, not a box
      const label = g.sort((a, b) => a.y - b.y || a.x - b.x).map(i => i.str).join(' ');
      // connector glyphs (arrows) and stray marks are not steps
      if (label.replace(/[^\p{L}\p{N}]/gu, '').length < 3) continue;
      state.steps.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, label: label.slice(0, 90), section: null });
    }
  }
  if (state.steps.length >= 3) {
    state.docType = 'flow';
    state.steps.sort((a, b) => (Math.abs(a.y - b.y) < 24 ? a.x - b.x : a.y - b.y));
    return;
  }

  // ---- generic document: bands of lines split on large vertical gaps
  state.steps = [];
  if (allLines.length >= 4) {
    state.docType = 'document';
    allLines.sort((a, b) => a.y - b.y);
    const gaps = [];
    for (let i = 1; i < allLines.length; i++) gaps.push(allLines[i].y - (allLines[i - 1].y + allLines[i - 1].h));
    const med = gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)] || 6;
    let band = [allLines[0]];
    const flush = () => {
      const x0 = Math.min(...band.map(L => L.x0)), x1 = Math.max(...band.map(L => L.x1));
      const y0 = band[0].y, y1 = band[band.length - 1].y + band[band.length - 1].h;
      state.steps.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, label: band[0].text.slice(0, 80), section: null });
    };
    for (let i = 1; i < allLines.length; i++) {
      if (allLines[i].y - (allLines[i - 1].y + allLines[i - 1].h) > Math.max(med * 2.5, 18)) { flush(); band = []; }
      band.push(allLines[i]);
    }
    flush();
  }
}

/* ---------------- cinematic camera: glide the spotlight ---------------- */

let glideRaf = null;
function glideSpotTo(rect, ms = 520) {
  const sp = ensureSpot(true);
  cancelAnimationFrame(glideRaf);
  const from = { x: sp.x, y: sp.y, w: sp.w, h: sp.h };
  const t0 = performance.now();
  const ease = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const frame = now => {
    const k = Math.min(1, (now - t0) / ms), e = ease(k);
    sp.x = from.x + (rect.x - from.x) * e;
    sp.y = from.y + (rect.y - from.y) * e;
    sp.w = from.w + (rect.w - from.w) * e;
    sp.h = from.h + (rect.h - from.h) * e;
    placeRect(sp);
    if (k < 1) glideRaf = requestAnimationFrame(frame);
  };
  glideRaf = requestAnimationFrame(frame);
}

const padStep = s => ({ x: s.x - 16, y: s.y - 14, w: s.w + 32, h: s.h + 28 });

/* ---------------- stepping through the detected terrain ---------------- */

function stepTo(i, scroll = true) {
  if (!state.steps.length) return;
  state.stepIdx = ((i % state.steps.length) + state.steps.length) % state.steps.length;
  const target = padStep(state.steps[state.stepIdx]);
  glideSpotTo(target);
  if (scroll) ensureVisible(target);
  updateChip();
}
const stepNext = () => stepTo(state.stepIdx + 1);
const stepPrev = () => stepTo(state.stepIdx - 1);

/* auto-preview on load: hop through the steps visible right now (no scrolling);
   loop when the last one before the fold is reached; any interaction takes over */
function startPreview() {
  stopPreview();
  const z = state.zoom, y0 = vp.scrollTop / z, y1 = (vp.scrollTop + vp.clientHeight) / z;
  const vis = state.steps.map((s, i) => ({ s, i }))
    .filter(o => o.s.y >= y0 - 10 && o.s.y + o.s.h <= y1 + 10);
  if (!vis.length) return;
  let k = 0;
  const hop = () => {
    const o = vis[k % vis.length]; k++;
    state.stepIdx = o.i;
    glideSpotTo(padStep(o.s));
    updateChip(true);
  };
  hop();
  state.preview = setInterval(hop, 1300);
}
function stopPreview() {
  if (state.preview) { clearInterval(state.preview); state.preview = null; updateChip(); }
}

function setStepsOn(on) {
  state.stepsOn = on;
  $('#bSteps').classList.toggle('on', on);
  if (on && state.steps.length) { ensureSpot(true); startPreview(); }
  else { stopPreview(); killSpot(); }
  updateChip();
}

const TYPE_LABEL = { flow: 'Flow chart', contract: 'Contract', document: 'Document' };
function updateChip(previewing) {
  const chip = $('#stepchip');
  if (state.audience || !state.stepsOn || !state.steps.length) { chip.classList.remove('show'); return; }
  chip.classList.add('show');
  const n = state.steps.length, i = state.stepIdx + 1;
  $('#stepinfo').innerHTML = previewing || state.preview
    ? `⚡ <b>${TYPE_LABEL[state.docType] || 'Document'}</b> — ${n} steps detected · previewing — click to take control`
    : `⚡ <b>${TYPE_LABEL[state.docType] || 'Document'}</b> · step <b>${i}/${n}</b> — click: next · right-click: back`;
}

/* ---------------- jump anywhere: shared matcher for voice + typed ---------------- */

function bigrams(s) {
  const t = s.toLowerCase().replace(/[^\p{L}\p{N} .]/gu, ' ').replace(/\s+/g, ' ').trim();
  const set = new Map();
  for (let i = 0; i < t.length - 1; i++) {
    const b = t.slice(i, i + 2);
    set.set(b, (set.get(b) || 0) + 1);
  }
  return set;
}
function dice(a, b) {
  let inter = 0, na = 0, nb = 0;
  for (const v of a.values()) na += v;
  for (const v of b.values()) nb += v;
  for (const [k, v] of a) inter += Math.min(v, b.get(k) || 0);
  return na + nb ? (2 * inter) / (na + nb) : 0;
}
/* short spoken queries ("email") vs long labels: weigh how much of the QUERY is
   covered by the label, use symmetric dice only as a tie-breaker */
function matchScore(qb, label) {
  const lb = bigrams(label);
  let inter = 0, nq = 0;
  for (const v of qb.values()) nq += v;
  for (const [k, v] of qb) inter += Math.min(v, lb.get(k) || 0);
  const coverage = nq ? inter / nq : 0;
  return coverage * 0.75 + dice(qb, lb) * 0.25;
}

function matchStep(query) {
  if (!state.steps.length) return null;
  const q = query.toLowerCase().trim();
  const num = q.match(/\d+(?:\.\d+)*/);
  if (num) {
    const hit = state.steps.findIndex(s => s.section === num[0]);
    if (hit >= 0) return { idx: hit, score: 1, step: state.steps[hit] };
  }
  const qb = bigrams(q);
  let best = -1, bestScore = 0;
  state.steps.forEach((s, i) => {
    const sc = matchScore(qb, s.label);
    if (sc > bestScore) { bestScore = sc; best = i; }
  });
  return bestScore >= 0.5 ? { idx: best, score: bestScore, step: state.steps[best] } : null;
}

/* ---------------- voice jump ----------------
   False-positive strategy (the room is full of voices):
   1. default is push-to-talk — hold V while speaking; nothing is heard otherwise
   2. hands-free mode requires a command phrase ("go to …", "show …", "section …")
   3. engine confidence threshold + 1.5 s cooldown between jumps
   4. every jump shows what was heard and where it went, so mistakes are visible
      and reversible (right-click steps back)
   True speaker identification isn't feasible in-browser; push-to-talk is the
   honest, robust default. */

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, lastJumpAt = 0;

function startVoice(handsFree) {
  if (!SR || rec) return;
  rec = new SR();
  rec.lang = navigator.language || 'en-US';
  rec.interimResults = false;
  rec.maxAlternatives = 3;
  rec.continuous = !!handsFree;
  rec.onresult = e => {
    const res = e.results[e.results.length - 1];
    handleVoice([...res].map(a => ({ t: a.transcript.trim(), c: a.confidence })), handsFree);
  };
  rec.onend = () => { rec = null; if (state.voiceFree && handsFree) startVoice(true); else voiceUI(false); };
  rec.onerror = ev => {
    if (ev.error === 'not-allowed') { state.voiceFree = false; toast('Microphone blocked — allow mic access to use voice jump'); }
  };
  try { rec.start(); voiceUI(true); } catch { rec = null; }
}
function stopVoice() {
  state.voiceHold = false;
  if (rec) { const r = rec; rec = null; try { r.stop(); } catch {} }
  voiceUI(false);
}
function voiceUI(on) { $('#bVoice').classList.toggle('listening', on && (state.voiceHold || state.voiceFree)); }

const CMD = /^(?:go to|goto|jump to|show me|show|open|section|clause|article)\s+(.+)$/i;
function handleVoice(alts, handsFree) {
  const now = Date.now();
  if (now - lastJumpAt < 1500) return;
  for (const a of alts) {
    if (!a.t) continue;
    let q = null;
    const m = a.t.match(CMD);
    if (m) q = m[1];
    else if (!handsFree) q = a.t;            // push-to-talk: the utterance IS the query
    if (!q) continue;
    if (a.c !== undefined && a.c > 0 && a.c < 0.45) continue;
    const hit = matchStep(q);
    if (hit) {
      lastJumpAt = now;
      stopPreview();
      if (!state.stepsOn) setStepsOn(true), stopPreview();
      toast(`🎤 "${a.t}" → ${hit.step.section ? 'section ' + hit.step.section + ' · ' : ''}${hit.step.label.slice(0, 50)}`);
      stepTo(hit.idx);
      return;
    }
  }
}

/* ---------------- typed jump (Ctrl+K) — same matcher, mic-free ---------------- */

function paletteOpen() {
  if (!state.steps.length) { toast('No steps detected in this document'); return; }
  $('#palette').classList.add('show');
  const q = $('#palq'); q.value = ''; $('#palres').innerHTML = ''; q.focus();
}
function paletteClose() { $('#palette').classList.remove('show'); }

$('#palq').addEventListener('input', () => {
  const q = $('#palq').value.trim(), box = $('#palres');
  box.innerHTML = '';
  if (!q) return;
  const qb = bigrams(q);
  const scored = state.steps.map((s, i) => ({ i, s, sc: matchScore(qb, s.label) }))
    .concat(/\d/.test(q) ? state.steps.map((s, i) => ({ i, s, sc: s.section && q.includes(s.section) ? 1 : 0 })) : [])
    .sort((a, b) => b.sc - a.sc).slice(0, 5).filter(r => r.sc > 0.12);
  scored.forEach((r, k) => {
    const d = document.createElement('div');
    d.className = 'pr' + (k === 0 ? ' hot' : '');
    d.innerHTML = (r.s.section ? '<b>' + r.s.section + '</b> · ' : '') + r.s.label.slice(0, 70);
    d.addEventListener('click', () => { paletteClose(); stopPreview(); stepTo(r.i); });
    box.appendChild(d);
  });
});
$('#palq').addEventListener('keydown', e => {
  e.stopPropagation();
  if (e.key === 'Escape') paletteClose();
  if (e.key === 'Enter') {
    const hit = matchStep($('#palq').value);
    paletteClose();
    if (hit) { stopPreview(); stepTo(hit.idx); }
  }
});

/* ---------------- audience screen: a window that shows only the sheet ---------------- */

let audWin = null, audTimer = null, lastSnap = '';

function openAudience() {
  if (!state.src) return;
  if (audWin && !audWin.closed) { audWin.focus(); return; }
  audWin = window.open(location.href, 'fp-audience', 'width=1100,height=750');
  if (!audWin) { toast('Popup blocked — allow popups to open the audience screen'); return; }
  toast('Audience screen opened — drag it to the projector; it shows only the sheet');
}

window.addEventListener('message', async e => {
  if (!e.data || !e.data.fp) return;
  if (e.data.fp === 'ready' && audWin && e.source === audWin) {
    const src = state.src;
    if (src.kind === 'pdf') audWin.postMessage({ fp: 'init', kind: 'pdf', buf: src.buf.slice(0) }, '*');
    else {
      const items = [];
      for (const f of src.files) items.push({ buf: await f.arrayBuffer(), type: f.type });
      audWin.postMessage({ fp: 'init', kind: 'imgs', items }, '*');
    }
    clearInterval(audTimer);
    lastSnap = '';
    audTimer = setInterval(syncAudience, 90);
  }
  if (e.data.fp === 'init' && state.audience) {
    if (e.data.kind === 'pdf') openPDF(e.data.buf, 'presentation');
    else openImages(e.data.items.map(it => new File([it.buf], 'slide', { type: it.type })));
  }
  if (e.data.fp === 'state' && state.audience) applyRemote(e.data.s);
});

function snapshot() {
  const z = state.zoom;
  return {
    style: state.style, shade: state.shade,
    slates: state.slates.map(s => ({ x: s.x, y: s.y, w: s.w, h: s.h, holes: s.holes.map(h => ({ x: h.x, y: h.y, w: h.w, h: h.h })) })),
    spot: state.spot ? { x: state.spot.x, y: state.spot.y, w: state.spot.w, h: state.spot.h } : null,
    cx: (vp.scrollLeft + vp.clientWidth / 2) / z,
    cy: (vp.scrollTop + vp.clientHeight / 2) / z,
  };
}

function syncAudience() {
  if (!audWin || audWin.closed) { clearInterval(audTimer); audTimer = null; return; }
  const s = snapshot(), j = JSON.stringify(s);
  if (j !== lastSnap) { lastSnap = j; audWin.postMessage({ fp: 'state', s }, '*'); }
}

let lastShades = '';
function applyRemote(s) {
  state.style = s.style; state.shade = s.shade;
  const shadeKey = JSON.stringify([s.slates, s.style, s.shade]);
  if (shadeKey !== lastShades) {
    lastShades = shadeKey;
    for (const sl of [...state.slates]) killSlate(sl);
    for (const r of s.slates) {
      const sl = spawnSlate({ x: r.x, y: r.y, w: r.w, h: r.h });
      for (const h of r.holes) addHole(sl, h);
    }
    select(null);
    applyShade();
  }
  if (s.spot) {
    const sp = ensureSpot(true);
    Object.assign(sp, s.spot);
    applyShade();
    placeRect(sp);
  } else if (state.spot) killSpot();
  const z = state.zoom;
  vp.scrollLeft = s.cx * z - vp.clientWidth / 2;
  vp.scrollTop = s.cy * z - vp.clientHeight / 2;
  scheduleRender();
}

function enterAudienceMode() {
  state.audience = true;
  document.body.classList.add('audience');
  const hello = setInterval(() => {
    if (state.pages.length) { clearInterval(hello); return; }
    if (window.opener) window.opener.postMessage({ fp: 'ready' }, '*');
  }, 250);
  $('#audFS').addEventListener('click', () => {
    document.documentElement.requestFullscreen();
    document.body.classList.add('fs');
  });
  document.addEventListener('fullscreenchange', () =>
    document.body.classList.toggle('fs', !!document.fullscreenElement));
}

/* ---------------- input wiring ---------------- */

$('#bOpen').addEventListener('click', () => $('#file').click());
$('#bOpen2').addEventListener('click', () => $('#file').click());
$('#file').addEventListener('change', e => { openFiles([...e.target.files]); e.target.value = ''; });

function openFiles(files) {
  if (!files.length) return;
  const pdf = files.find(f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  if (pdf) {
    pdf.arrayBuffer().then(buf => {
      state.src = { kind: 'pdf', buf: buf.slice(0) };   // keep a copy for the audience screen
      openPDF(buf, pdf.name);
    }).catch(err => { console.error(err); toast('Could not open ' + pdf.name); });
    return;
  }
  const imgs = files.filter(f => /^image\//.test(f.type));
  if (imgs.length) {
    if (!hasDoc()) resetDoc();
    state.src = state.src?.kind === 'imgs' ? { kind: 'imgs', files: state.src.files.concat(imgs) } : { kind: 'imgs', files: imgs };
    openImages(imgs);
    return;
  }
  if (files.some(f => /\.(pptx?|key|odp)$/i.test(f.name)))
    toast('Slides detected — export the deck as PDF first (File → Export → PDF), then open it here', 5200);
  else
    toast('Unsupported file — open a PDF or images');
}

['dragenter', 'dragover'].forEach(ev => document.addEventListener(ev, e => {
  e.preventDefault(); document.body.classList.add('dragover');
}));
['dragleave', 'drop'].forEach(ev => document.addEventListener(ev, e => {
  e.preventDefault(); if (ev === 'drop' || e.target === document.body) document.body.classList.remove('dragover');
}));
document.addEventListener('drop', e => openFiles([...e.dataTransfer.files]));

document.addEventListener('paste', e => {
  const imgs = [...(e.clipboardData?.items || [])]
    .filter(i => /^image\//.test(i.type)).map(i => i.getAsFile()).filter(Boolean);
  if (imgs.length) {
    state.src = state.src?.kind === 'imgs' ? { kind: 'imgs', files: state.src.files.concat(imgs) } : { kind: 'imgs', files: imgs };
    openImages(imgs);
    toast('Screenshot pasted as a new slide');
  }
});

$('#bSlate').addEventListener('click', () => spawnSlate());
$('#bCurtain').addEventListener('click', spawnCurtain);
$('#bSpot').addEventListener('click', toggleSpot);
$('#bTear').addEventListener('click', () => toggleTear());
$('#bClear').addEventListener('click', () => killAllShades());
$('#bSteps').addEventListener('click', () => setStepsOn(!state.stepsOn));
$('#stepoff').addEventListener('click', () => {
  setStepsOn(false);
  toast('Auto-steps off — press P or ⚡ Steps to turn back on');
});
$('#bVoice').addEventListener('click', () => {
  if (!SR) return;
  state.voiceFree = !state.voiceFree;
  if (state.voiceFree) {
    startVoice(true);
    toast('Hands-free listening on — say “go to …” / “section …”. Hold V instead for push-to-talk');
  } else stopVoice();
});
$('#bPresent').addEventListener('click', openAudience);
$('#bZi').addEventListener('click', () => setZoom(state.zoom * 1.2));
$('#bZo').addEventListener('click', () => setZoom(state.zoom / 1.2));
$('#bFit').addEventListener('click', fitWidth);
$('#bFull').addEventListener('click', toggleFull);
$('#bHelp').addEventListener('click', () => $('#help').showModal());
$('#op').addEventListener('input', e => { state.shade = e.target.value / 100; applyShade(); });
document.querySelectorAll('.sw').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.sw').forEach(x => x.classList.toggle('on', x === b));
  state.style = b.dataset.st;
  applyShade();
}));

function toggleFull() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen();
}

vp.addEventListener('wheel', e => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  if (!hasDoc()) return;
  const rc = vp.getBoundingClientRect();
  setZoom(state.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12), e.clientX - rc.left, e.clientY - rc.top);
}, { passive: false });

vp.addEventListener('scroll', scheduleRender);
window.addEventListener('resize', () => { layout(); scheduleRender(); });

/* background clicks: take control of the preview, then walk the steps —
   left-click = next, right-click = back (so the speaker can roam the room
   with just a mouse in hand) */
function isBackground(t) {
  return t === vp || t === doc || t === overlay || t.classList.contains('page')
      || t.parentElement?.classList.contains('page');
}
vp.addEventListener('pointerdown', e => {
  if (!isBackground(e.target)) return;
  select(null);
  if (state.audience || !state.stepsOn || !state.steps.length || !state.spot) return;
  if (state.preview) { stopPreview(); return; }   // first click just takes control
  if (e.button === 0) stepNext();
});
vp.addEventListener('contextmenu', e => {
  if (state.audience || !state.stepsOn || !state.steps.length || !state.spot) return;
  e.preventDefault();
  if (state.preview) { stopPreview(); return; }
  stepPrev();
});

document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  if (state.audience) {
    if (e.key.toLowerCase() === 'f') toggleFull();
    return;
  }
  const help = $('#help');
  if (e.key === 'Escape') {
    if ($('#palette').classList.contains('show')) paletteClose();
    else if (help.open) help.close();
    else if (state.tear) setTear(false);
    else select(null);
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    stopPreview();
    paletteOpen();
    return;
  }
  if (state.preview && e.key !== 'Escape') stopPreview();
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key.toLowerCase() === 'v' && !e.repeat && SR) {
    state.voiceHold = true;
    startVoice(false);
    return;
  }
  const k = e.key.toLowerCase();
  const target = state.sel || state.spot;
  if (e.key.startsWith('Arrow') && target) {
    e.preventDefault();
    const step = (e.shiftKey ? 60 : 8) / 1;   // doc units
    if (e.key === 'ArrowLeft') target.x -= step;
    if (e.key === 'ArrowRight') target.x += step;
    if (e.key === 'ArrowUp') target.y -= step;
    if (e.key === 'ArrowDown') target.y += step;
    placeRect(target);
    ensureVisible(target);
    return;
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && state.sel) {
    e.preventDefault();
    if (state.sel.id === 'spot') killSpot(); else killSlate(state.sel);
    return;
  }
  if (k === 'o') $('#file').click();
  else if (k === 'f') toggleFull();
  else if (k === 'h') document.body.classList.toggle('zen');
  else if (k === '?') help.open ? help.close() : help.showModal();
  else if (!hasDoc()) return;
  else if (k === 's') spawnSlate();
  else if (k === 'c') spawnCurtain();
  else if (k === 't') toggleTear();
  else if (k === 'l') toggleSpot();
  else if (k === 'p') setStepsOn(!state.stepsOn);
  else if (k === 'k') paletteOpen();
  else if (k === 'x') killAllShades();
  else if (k === 'w') fitWidth();
  else if (k === '0') setZoom(1);
  else if (k === '+' || k === '=') setZoom(state.zoom * 1.2);
  else if (k === '-') setZoom(state.zoom / 1.2);
});

document.addEventListener('keyup', e => {
  if (e.key.toLowerCase() === 'v' && state.voiceHold && !state.voiceFree) stopVoice();
});

/* ---------------- boot ---------------- */

if (window.name === 'fp-audience' && window.opener) enterAudienceMode();
if (!SR) $('#bVoice').style.display = 'none';
