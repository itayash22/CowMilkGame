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

pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(
  new Blob([document.getElementById('pdf-worker-code').textContent], { type: 'text/javascript' })
);

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
  for (const id of ['bSlate', 'bCurtain', 'bSpot', 'bTear', 'bClear', 'bZi', 'bZo', 'bFit'])
    $('#' + id).disabled = false;
  fitWidth();
  vp.scrollTop = 0; vp.scrollLeft = 0;
  scheduleRender();
  toast(msg + ' — press S for a slate, C for a curtain, L for spotlight', 4200);
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

function toggleSpot() {
  if (state.spot) { killSpot(); return; }
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
  select(sp);
  $('#bSpot').classList.add('on');
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

/* ---------------- input wiring ---------------- */

$('#bOpen').addEventListener('click', () => $('#file').click());
$('#bOpen2').addEventListener('click', () => $('#file').click());
$('#file').addEventListener('change', e => { openFiles([...e.target.files]); e.target.value = ''; });

function openFiles(files) {
  if (!files.length) return;
  const pdf = files.find(f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  if (pdf) {
    pdf.arrayBuffer().then(buf => openPDF(buf, pdf.name))
      .catch(err => { console.error(err); toast('Could not open ' + pdf.name); });
    return;
  }
  const imgs = files.filter(f => /^image\//.test(f.type));
  if (imgs.length) { if (!hasDoc()) resetDoc(); openImages(imgs); return; }
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
  if (imgs.length) { openImages(imgs); toast('Screenshot pasted as a new slide'); }
});

$('#bSlate').addEventListener('click', () => spawnSlate());
$('#bCurtain').addEventListener('click', spawnCurtain);
$('#bSpot').addEventListener('click', toggleSpot);
$('#bTear').addEventListener('click', () => toggleTear());
$('#bClear').addEventListener('click', () => killAllShades());
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

/* click empty space → deselect */
vp.addEventListener('pointerdown', e => {
  if (e.target === vp || e.target === doc || e.target.parentElement?.classList.contains('page')
      || e.target.classList.contains('page')) select(null);
});

document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  const help = $('#help');
  if (e.key === 'Escape') {
    if (help.open) help.close();
    else if (state.tear) setTear(false);
    else select(null);
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
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
  else if (k === 'x') killAllShades();
  else if (k === 'w') fitWidth();
  else if (k === '0') setZoom(1);
  else if (k === '+' || k === '=') setZoom(state.zoom * 1.2);
  else if (k === '-') setZoom(state.zoom / 1.2);
});
