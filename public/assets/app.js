/* Labkom Photobooth — vanilla JS, no third-party frontend dependencies. */
'use strict';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));
const MAX_OUTPUT_SIZE = 20 * 1024 * 1024;
const SESSION_SECONDS = 120;
const SHOT_COUNTDOWN = 5;
const SHOT_PREVIEW_MS = 1000; // quick look at each photo before the next automatic countdown
const FINAL_SIZE = { width: 2160, height: 3840 };
const RESULT_IDLE_SECONDS = 120; // result screen returns to start so the next visitor never sees the previous photo
// Camera effects, Photo Booth (Mac) style. Same list for the live camera and the review filter tab:
// `css` runs through ctx.filter, `px` edits pixels, `warp` remaps pixels through a cached lookup table.
const FILTERS = [
  { id: 'normal', label: 'Normal', group: 'all', css: 'none' },
  { id: 'bulge', label: 'Bulge', group: 'distort', warp: 'bulge' },
  { id: 'dent', label: 'Dent', group: 'distort', warp: 'dent' },
  { id: 'twirl', label: 'Twirl', group: 'distort', warp: 'twirl' },
  { id: 'squeeze', label: 'Squeeze', group: 'distort', warp: 'squeeze' },
  { id: 'mirror', label: 'Mirror', group: 'distort', warp: 'mirror' },
  { id: 'tunnel', label: 'Light Tunnel', group: 'distort', warp: 'tunnel' },
  { id: 'fisheye', label: 'Fish Eye', group: 'distort', warp: 'fisheye' },
  { id: 'stretch', label: 'Stretch', group: 'distort', warp: 'stretch' },
  { id: 'vintage', label: 'Sepia', group: 'color', css: 'sepia(.85) contrast(1.08) brightness(1.04) saturate(1.1)' },
  { id: 'bw', label: 'Hitam putih', group: 'color', css: 'grayscale(1) contrast(1.3) brightness(1.05)' },
  { id: 'glow', label: 'Glow', group: 'color', px: glowFx },
  { id: 'komik', label: 'Komik', group: 'color', px: comicFx },
  { id: 'pensil', label: 'Pensil warna', group: 'color', px: pencilFx },
  { id: 'thermal', label: 'Thermal', group: 'color', px: thermalFx },
  { id: 'xray', label: 'X-Ray', group: 'color', px: xrayFx },
  { id: 'popart', label: 'Pop Art', group: 'color', px: popArtFx },
];
// Fun overlays drawn into the photo itself: `face` ones follow detected faces, `scene` ones fill the frame.
const OVERLAYS = [
  { id: 'none', label: 'Tanpa efek lucu', group: 'all' },
  { id: 'love', label: 'Love', icon: '💕', group: 'face' },
  { id: 'sparkle', label: 'Bintang', icon: '⭐', group: 'face' },
  { id: 'crown', label: 'Mahkota', icon: '👑', group: 'face' },
  { id: 'cat', label: 'Kucing', icon: '🐱', group: 'face' },
  { id: 'bunny', label: 'Kelinci', icon: '🐰', group: 'face' },
  { id: 'shades', label: 'Kacamata', icon: '😎', group: 'face' },
  { id: 'flowers', label: 'Mahkota bunga', icon: '🌸', group: 'face' },
  { id: 'halo', label: 'Malaikat', icon: '😇', group: 'face' },
  { id: 'confetti', label: 'Confetti', icon: '🎉', group: 'scene' },
  { id: 'bubbles', label: 'Gelembung', icon: '🫧', group: 'scene' },
  { id: 'snow', label: 'Salju', icon: '❄️', group: 'scene' },
  { id: 'sakura', label: 'Sakura', icon: '🌸', group: 'scene' },
  { id: 'balloons', label: 'Balon', icon: '🎈', group: 'scene' },
  { id: 'hearts', label: 'Hujan love', icon: '💖', group: 'scene' },
  { id: 'stars', label: 'Kilau', icon: '✨', group: 'scene' },
  { id: 'emoji', label: 'Hujan emoji', icon: '🥳', group: 'scene' },
];
// Pages of the 3×3 effect grid (Normal sits in the middle, as on a Mac).
const EFFECT_PAGES = [
  { id: 'distort', label: 'Distorsi', kind: 'filter' },
  { id: 'color', label: 'Warna', kind: 'filter' },
  { id: 'face', label: 'Lucu', kind: 'overlay' },
  { id: 'scene', label: 'Suasana', kind: 'overlay' },
];
const BASE = window.BASE_PATH || ''; // set by server.py when served under a sub-path (e.g. /photobooth)
const FX_SIZE = { width: 800, height: 600 }; // pixel effects run at a fixed size so line weight matches the live preview
const LIVE_FX_SIZE = { width: 640, height: 480 };
const EMOJIS = ['😎', '🥳', '😍', '🤩', '😂', '🔥', '✨', '💖', '👑', '🎓', '🎉', '🦌'];
const MAX_STICKERS = 12;
const EMOJI_FONT = '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';

const state = {
  profile: null,
  templates: [],
  template: null,
  templateImage: null,
  artPromise: null,
  photos: [null, null, null],
  videoStream: null,
  endsAt: 0,
  interval: null,
  currentShot: 0,
  retaking: false,
  countingDown: false,
  uploading: false,
  step: 'register',
  result: null,
  liveDraw: 0,
  idleEndsAt: 0,
  idleTimer: null,
  frameArmTimer: null,
  filters: ['normal', 'normal', 'normal'], // one filter id per photo
  filterTarget: -1, // review filter tab: -1 = all photos, otherwise photo index
  liveFilter: 'normal', // camera effect; copied into filters[] when a photo is taken
  liveOverlay: 'none', // fun overlay; baked into the raw photo at capture
  overlays: ['none', 'none', 'none'], // overlay id per photo, so a retake reopens with the same one
  layers: [null, null, null], // per photo: transparent PNG of its fun overlay, drawn on top of the filtered photo
  effectPage: 'distort', // open page of the 3×3 effect grid
  stickerSources: [], // image sticker URLs from /api/stickers
  stickers: [], // { emoji | src, x, y, size, rot } — x/y/size as fractions of the poster width/height, rot in degrees
  selectedSticker: -1,
};
const fxCache = []; // per photo: { id, canvas } for its current filter
const artCache = new Map(); // sticker src → Promise<img>
let liveFxRaf = 0;
let toastTimer;
let countdownAbort = false;
let stopRequested = false;
let audioCtx = null;

function toast(message, tone = 'info') {
  const element = $('#toast');
  element.textContent = message;
  element.dataset.tone = tone;
  element.hidden = false;
  element.classList.remove('show'); void element.offsetWidth; element.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.hidden = true, 4800);
}
function humanTime(seconds) {
  const s = Math.max(0, Math.ceil(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
function timeRemaining() { return Math.max(0, (state.endsAt - Date.now()) / 1000); }
function sessionExpired() { return state.endsAt > 0 && timeRemaining() <= 0; }
function allPhotosReady() { return state.photos.every(Boolean); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function nextFrame() { return new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0))); }
function clamp(value, min = 0, max = 1) { return Math.min(max, Math.max(min, value)); }
function icon(id) { return `<svg class="ico" aria-hidden="true"><use href="#${id}"/></svg>`; }
function filterCss(f, blurPx) { return (f.css || 'none').replace('{blur}', `${blurPx.toFixed(2)}px`); }
function filterById(id) { return FILTERS.find(f => f.id === id) || FILTERS[0]; }
function overlayById(id) { return OVERLAYS.find(o => o.id === id) || OVERLAYS[0]; }
function fixedSize(f) { return Boolean(f.px || f.warp); } // effects computed at FX_SIZE/LIVE_FX_SIZE
function shotCount() { return state.template?.slots.length ?? 3; }
function slotName(i) {
  // Derived from slot positions so 3-in-a-column and 2×2 frames both read naturally ("tengah", "kiri bawah").
  const slots = state.template?.slots, s = slots?.[i];
  if (!s) return `${i + 1}`;
  const sameRow = o => Math.abs(o.y - s.y) <= s.h / 2;
  const rows = [];
  for (const o of [...slots].sort((a, b) => a.y - b.y)) if (!rows.length || o.y - rows.at(-1) > o.h / 2) rows.push(o.y);
  const r = rows.findIndex(y => Math.abs(y - s.y) <= s.h / 2);
  const row = (rows.length === 2 ? ['atas', 'bawah'] : ['atas', 'tengah', 'bawah'])[r] ?? `baris ${r + 1}`;
  const mates = slots.filter(sameRow);
  if (mates.length < 2) return row;
  return `${s.x === Math.min(...mates.map(o => o.x)) ? 'kiri' : 'kanan'} ${row}`;
}

/* ---------- Effects (Photo Booth style, plain canvas pixel ops) ---------- */
function blankCanvas(w, h) { return Object.assign(document.createElement('canvas'), { width: w, height: h }); }
function effectCanvas(source, f, w, h, canvas = blankCanvas(w, h)) {
  const ctx = canvas.getContext('2d', { willReadFrequently: fixedSize(f) });
  ctx.filter = 'none';
  drawImageCover(ctx, source, { x: 0, y: 0, w, h, r: 0 }, filterCss(f, w * .0015));
  if (f.px) f.px(ctx, w, h);
  if (f.warp) applyWarp(ctx, w, h, f.warp);
  return canvas;
}
function luma(p, i) { return p[i] * .299 + p[i + 1] * .587 + p[i + 2] * .114; }
function softPixels(ctx, w, h) {
  // Slightly blurred copy so edge detection follows faces, not sensor noise.
  const t = blankCanvas(w, h).getContext('2d', { willReadFrequently: true });
  t.filter = `blur(${w / 640}px)`;
  t.drawImage(ctx.canvas, 0, 0);
  return t.getImageData(0, 0, w, h).data;
}
function edgeMap(p, w, h) {
  const g = new Float32Array(w * h), e = new Float32Array(w * h);
  for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = luma(p, i);
  for (let y = 1; y < h - 1; y++) for (let x = 1, k = y * w + 1; x < w - 1; x++, k++) {
    const gx = g[k - w + 1] + 2 * g[k + 1] + g[k + w + 1] - g[k - w - 1] - 2 * g[k - 1] - g[k + w - 1];
    const gy = g[k + w - 1] + 2 * g[k + w] + g[k + w + 1] - g[k - w - 1] - 2 * g[k - w] - g[k - w + 1];
    e[k] = Math.abs(gx) + Math.abs(gy);
  }
  return e;
}
function gradientLut(stops) {
  // stops: [position 0..1, r, g, b] → 256 RGB entries
  const lut = new Uint8ClampedArray(256 * 3);
  for (let v = 0; v < 256; v++) {
    const t = v / 255, b = stops.findIndex(s => s[0] >= t), a = Math.max(0, b - 1);
    const k = stops[b][0] === stops[a][0] ? 0 : (t - stops[a][0]) / (stops[b][0] - stops[a][0]);
    for (let c = 1; c < 4; c++) lut[v * 3 + c - 1] = stops[a][c] + (stops[b][c] - stops[a][c]) * k;
  }
  return lut;
}
const THERMAL_LUT = gradientLut([[0, 20, 0, 90], [.28, 110, 0, 170], [.5, 235, 20, 70], [.72, 255, 160, 0], [.9, 255, 240, 60], [1, 255, 255, 230]]);
function mapPixels(ctx, w, h, fn) {
  const image = ctx.getImageData(0, 0, w, h);
  fn(image.data);
  ctx.putImageData(image, 0, 0);
}
function thermalFx(ctx, w, h) {
  mapPixels(ctx, w, h, p => {
    for (let i = 0; i < p.length; i += 4) {
      const v = Math.round(luma(p, i)) * 3;
      p[i] = THERMAL_LUT[v]; p[i + 1] = THERMAL_LUT[v + 1]; p[i + 2] = THERMAL_LUT[v + 2];
    }
  });
}
function xrayFx(ctx, w, h) {
  mapPixels(ctx, w, h, p => {
    for (let i = 0; i < p.length; i += 4) {
      const v = clamp(((255 - luma(p, i)) - 128) * 1.45 + 128, 0, 255);
      p[i] = v * .55; p[i + 1] = v * .88; p[i + 2] = v * 1.05 + 20;
    }
  });
}
function comicFx(ctx, w, h) {
  const e = edgeMap(softPixels(ctx, w, h), w, h);
  mapPixels(ctx, w, h, p => {
    for (let i = 0, j = 0; i < p.length; i += 4, j++) {
      if (e[j] > 150) { p[i] = p[i + 1] = p[i + 2] = 18; continue; }
      const l = luma(p, i);
      for (let c = 0; c < 3; c++) p[i + c] = Math.round(clamp(l + (p[i + c] - l) * 1.7, 0, 255) / 64) * 64 + 24;
    }
  });
}
function pencilFx(ctx, w, h) {
  const e = edgeMap(softPixels(ctx, w, h), w, h);
  mapPixels(ctx, w, h, p => {
    for (let i = 0, j = 0; i < p.length; i += 4, j++) {
      const l = luma(p, i), ink = Math.min(1, e[j] / 260) * .9 + (255 - l) / 255 * .12;
      for (let c = 0; c < 3; c++) p[i + c] = (238 + (p[i + c] - l) * .45) * (1 - ink);
    }
  });
}
function glowFx(ctx, w, h) {
  const copy = blankCanvas(w, h);
  copy.getContext('2d').drawImage(ctx.canvas, 0, 0);
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  ctx.globalAlpha = .75;
  ctx.filter = `blur(${w / 70}px) brightness(.95) saturate(1.3)`;
  ctx.drawImage(copy, 0, 0);
  ctx.restore();
}
const POP_COLORS = [ // dark, mid, light per tile
  [[200, 0, 90], [255, 120, 0], [255, 236, 0]],
  [[20, 30, 160], [0, 190, 255], [180, 255, 120]],
  [[100, 0, 160], [255, 60, 160], [255, 200, 220]],
  [[0, 110, 70], [255, 210, 0], [255, 255, 255]],
];
function popArtFx(ctx, w, h) {
  // Warhol grid: the photo four times, each posterized into its own three inks.
  const tw = w >> 1, th = h >> 1;
  const small = blankCanvas(tw, th).getContext('2d', { willReadFrequently: true });
  small.drawImage(ctx.canvas, 0, 0, tw, th);
  const src = small.getImageData(0, 0, tw, th).data;
  POP_COLORS.forEach((inks, t) => {
    const tile = small.createImageData(tw, th), p = tile.data;
    for (let i = 0; i < p.length; i += 4) {
      const ink = inks[Math.min(2, Math.floor(luma(src, i) / 86))];
      p[i] = ink[0]; p[i + 1] = ink[1]; p[i + 2] = ink[2]; p[i + 3] = 255;
    }
    ctx.putImageData(tile, (t % 2) * tw, (t >> 1) * th);
  });
}
/* ---------- Distortions (Bulge, Twirl, …): inverse map, one lookup table per effect and size ---------- */
const warpCache = new Map();
const WARPS = {
  // Each takes the destination point (dx, dy) relative to the centre, in units of the half-height,
  // and returns where to sample the source, or null for black.
  bulge(x, y) { const r = Math.hypot(x, y), R = .9; return r < R ? scale(x, y, (r / R) ** .7) : [x, y]; },
  dent(x, y) { const r = Math.hypot(x, y), R = .9; return r < R ? scale(x, y, (r / R) ** -.45) : [x, y]; },
  twirl(x, y) {
    const r = Math.hypot(x, y), R = 1.05;
    if (r >= R) return [x, y];
    const a = Math.atan2(y, x) + 3.2 * (1 - r / R) ** 2;
    return [r * Math.cos(a), r * Math.sin(a)];
  },
  squeeze(x, y) { const f = Math.max(0, 1 - (x / 1.3) ** 2 - (y / 1.1) ** 2); return [x * (1 + 1.1 * f), y]; },
  stretch(x, y) { const f = Math.max(0, 1 - (x / 1.1) ** 2 - (y / 1.3) ** 2); return [x, y * (1 - .5 * f)]; },
  mirror(x, y) { return [-Math.abs(x), y]; },
  tunnel(x, y) { const r = Math.hypot(x, y), R = .48; return r < R ? [x, y] : scale(x, y, R * (.985 + .015 * Math.sin(Math.atan2(y, x) * 40)) / r); },
  fisheye(x, y) {
    const r = Math.hypot(x, y), R = 1.12;
    if (r > R) return null;
    const k = 1.9, t = r / R;
    return r ? scale(x, y, R * 1.25 * ((Math.exp(k * t) - 1) / (Math.exp(k) - 1)) / r) : [0, 0];
  },
};
function scale(x, y, k) { return [x * k, y * k]; }
function warpMap(id, w, h) {
  const key = `${id}:${w}x${h}`;
  if (!warpCache.has(key)) {
    const map = new Int32Array(w * h), cx = w / 2, cy = h / 2, unit = h / 2, fn = WARPS[id];
    for (let y = 0, k = 0; y < h; y++) for (let x = 0; x < w; x++, k++) {
      const p = fn((x + .5 - cx) / unit, (y + .5 - cy) / unit);
      if (!p) { map[k] = -1; continue; }
      const sx = Math.min(w - 1, Math.max(0, Math.round(cx + p[0] * unit - .5)));
      const sy = Math.min(h - 1, Math.max(0, Math.round(cy + p[1] * unit - .5)));
      map[k] = sy * w + sx;
    }
    warpCache.set(key, map);
  }
  return warpCache.get(key);
}
function applyWarp(ctx, w, h, id) {
  const map = warpMap(id, w, h);
  const src = new Uint32Array(ctx.getImageData(0, 0, w, h).data.buffer);
  const out = ctx.createImageData(w, h), dst = new Uint32Array(out.data.buffer);
  for (let k = 0; k < map.length; k++) dst[k] = map[k] < 0 ? 0xFF000000 : src[map[k]];
  ctx.putImageData(out, 0, 0);
}

/* ---------- Fun overlays: face accessories + scene particles, drawn into the photo ---------- */
// MediaPipe face detector (vendored in assets/vendor/mediapipe, loaded on first use).
const face = { detector: null, loading: null, failed: false, boxes: [], seenAt: 0, tick: 0 };
const DEFAULT_FACE = { x: .39, y: .3, w: .22, h: .3, kp: null }; // used only if the detector cannot load
function loadFaceDetector() {
  face.loading ??= (async () => {
    const root = `${location.origin}${BASE}/assets/vendor/mediapipe`;
    const { FilesetResolver, FaceDetector } = await import(`${root}/vision_bundle.mjs`);
    const fileset = await FilesetResolver.forVisionTasks(`${root}/wasm`);
    const make = delegate => FaceDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: `${root}/blaze_face_short_range.tflite`, delegate },
      runningMode: 'VIDEO', minDetectionConfidence: .5,
    });
    face.detector = await make('GPU').catch(() => make('CPU'));
  })().catch(error => { face.failed = true; console.warn('Deteksi wajah tidak tersedia:', error); });
  return face.loading;
}
function detectFaces(canvas) {
  // Every other frame is enough; boxes are smoothed so accessories do not jitter.
  if (!face.detector || face.tick++ % 2) return;
  let found;
  try { found = face.detector.detectForVideo(canvas, performance.now()).detections; } catch { return; }
  const now = performance.now();
  if (!found.length) { if (now - face.seenAt > 600) face.boxes = []; return; }
  face.seenAt = now;
  const next = found.slice(0, 4).map(d => {
    const b = d.boundingBox;
    return { x: b.originX / canvas.width, y: b.originY / canvas.height, w: b.width / canvas.width, h: b.height / canvas.height,
      kp: d.keypoints?.length >= 4 ? d.keypoints.map(k => [k.x, k.y]) : null };
  }).sort((a, b) => a.x - b.x);
  if (next.length !== face.boxes.length) { face.boxes = next; return; }
  const mix = (a, b) => a + (b - a) * .55;
  face.boxes = next.map((n, i) => {
    const o = face.boxes[i];
    return { x: mix(o.x, n.x), y: mix(o.y, n.y), w: mix(o.w, n.w), h: mix(o.h, n.h),
      kp: n.kp && o.kp ? n.kp.map((p, j) => [mix(o.kp[j][0], p[0]), mix(o.kp[j][1], p[1])]) : n.kp };
  });
}
function facesForDraw() { return face.boxes.length ? face.boxes : face.failed ? [DEFAULT_FACE] : []; }

function drawOverlay(ctx, w, h, id, t) {
  const o = overlayById(id);
  if (o.id === 'none') return;
  ctx.save();
  if (o.group === 'scene') SCENE_FX[o.id](ctx, w, h, t);
  else facesForDraw().forEach((f, i) => {
    const fw = f.w * w, fh = f.h * h, fx = f.x * w, fy = f.y * h;
    // BlazeFace boxes run from the brows to the chin, so the top of the head is ~40% above the box.
    const F = { fx, fy, fw, fh, cx: fx + fw / 2, top: fy - fh * .4, kp: f.kp?.map(([x, y]) => [x * w, y * h]) };
    ctx.save(); FACE_FX[o.id](ctx, F, t, i); ctx.restore();
  });
  ctx.restore();
}
function rand(i, k = 0) { const v = Math.sin(i * 127.1 + k * 311.7) * 43758.5453; return v - Math.floor(v); }
function heart(ctx, x, y, s, color) {
  ctx.beginPath();
  ctx.moveTo(x, y + s * .38);
  ctx.bezierCurveTo(x - s * .62, y - s * .02, x - s * .46, y - s * .62, x, y - s * .26);
  ctx.bezierCurveTo(x + s * .46, y - s * .62, x + s * .62, y - s * .02, x, y + s * .38);
  ctx.fillStyle = color; ctx.fill();
  ctx.beginPath(); ctx.ellipse(x - s * .22, y - s * .22, s * .09, s * .06, -.6, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,.75)'; ctx.fill();
}
function star(ctx, x, y, r, color, points = 5, inner = .45) {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const a = -Math.PI / 2 + i * Math.PI / points, rr = i % 2 ? r * inner : r;
    ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath(); ctx.fillStyle = color; ctx.fill();
}
function flower(ctx, x, y, r, petal, rot) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
  ctx.fillStyle = petal;
  for (let i = 0; i < 5; i++) {
    ctx.rotate(Math.PI * 2 / 5);
    ctx.beginPath(); ctx.ellipse(0, -r * .55, r * .38, r * .55, 0, 0, Math.PI * 2); ctx.fill();
  }
  ctx.beginPath(); ctx.arc(0, 0, r * .3, 0, Math.PI * 2); ctx.fillStyle = '#FFD23F'; ctx.fill();
  ctx.restore();
}
function eyes(F) {
  // Keypoints 0/1 are the eyes; estimate from the box when they are missing.
  if (F.kp) return [F.kp[0], F.kp[1]].sort((a, b) => a[0] - b[0]);
  const y = F.fy + F.fh * .36;
  return [[F.cx - F.fw * .2, y], [F.cx + F.fw * .2, y]];
}
const HEART_COLORS = ['#FF3D7F', '#FF6FA5', '#FF2D55', '#FF9EC4', '#E0218A'];
const PARTY_COLORS = ['#FF3D7F', '#FFD23F', '#3DDCFF', '#7CFF6B', '#B07CFF', '#FF8A3D'];
const FACE_FX = {
  love(ctx, F, t, seed) {
    for (let i = 0; i < 9; i++) {
      const ph = (t * .42 + i / 9 + seed * .17) % 1;
      const x = F.cx + Math.sin(ph * 7 + i * 1.9) * F.fw * .3 + (rand(i, 1) - .5) * F.fw * 1.1;
      const y = F.top + F.fh * .3 - ph * F.fh * .85;
      ctx.globalAlpha = ph < .15 ? ph / .15 : 1 - (ph - .15) / .85;
      heart(ctx, x, y, F.fw * (.22 + .12 * rand(i, 2)) * (1 + .12 * Math.sin(t * 8 + i)), HEART_COLORS[i % HEART_COLORS.length]);
    }
  },
  sparkle(ctx, F, t) {
    const stars = [];
    for (let i = 0; i < 10; i++) {
      const a = t * 1.3 + i * Math.PI * 2 / 10;
      stars.push({ x: F.cx + Math.cos(a) * F.fw * .72, y: F.top + F.fh * .08 + Math.sin(a) * F.fh * .16, depth: Math.sin(a), i });
    }
    ctx.shadowColor = '#FFF3A0'; ctx.shadowBlur = F.fw * .08;
    for (const s of stars.sort((a, b) => a.depth - b.depth)) {
      const r = F.fw * (.07 + .03 * s.depth) * (.8 + .3 * Math.sin(t * 6 + s.i));
      star(ctx, s.x, s.y, r, s.i % 3 ? '#FFE45C' : '#FFFFFF');
    }
  },
  crown(ctx, F, t) {
    const w = F.fw * 1.02, h = F.fh * .48, x = F.cx - w / 2, base = F.top + F.fh * .2 + Math.sin(t * 3) * F.fh * .015;
    const g = ctx.createLinearGradient(0, base - h, 0, base);
    g.addColorStop(0, '#FFF1A6'); g.addColorStop(.5, '#FFC93C'); g.addColorStop(1, '#D98E04');
    ctx.beginPath();
    ctx.moveTo(x, base);
    [[0, -.55], [.17, -.25], [.3, -.95], [.5, -.35], [.7, -.95], [.83, -.25], [1, -.55], [1, 0]]
      .forEach(([px, py]) => ctx.lineTo(x + px * w, base + py * h));
    ctx.closePath();
    ctx.fillStyle = g; ctx.shadowColor = 'rgba(0,0,0,.35)'; ctx.shadowBlur = F.fw * .04; ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#B8770A'; ctx.fillRect(x, base - h * .2, w, h * .2);
    [[.15, '#FF2D55'], [.5, '#3DA5FF'], [.85, '#2BD67B']].forEach(([px, c]) => {
      ctx.beginPath(); ctx.arc(x + px * w, base - h * .1, h * .09, 0, Math.PI * 2); ctx.fillStyle = c; ctx.fill();
    });
    [[.3, -.95], [.7, -.95], [0, -.55], [1, -.55]].forEach(([px, py]) => {
      ctx.beginPath(); ctx.arc(x + px * w, base + py * h, h * .07, 0, Math.PI * 2); ctx.fillStyle = '#FFFFFF'; ctx.fill();
    });
    ctx.globalAlpha = .5 + .5 * Math.sin(t * 5);
    star(ctx, x + w * .62, base - h * .55, h * .14, '#FFFFFF', 4, .3);
  },
  cat(ctx, F, t) {
    const wob = Math.sin(t * 4) * .05;
    [-1, 1].forEach(side => {
      ctx.save();
      ctx.translate(F.cx + side * F.fw * .32, F.top + F.fh * .18);
      ctx.rotate(side * (.32 + wob));
      const ew = F.fw * .38, eh = F.fh * .5;
      ctx.beginPath(); ctx.moveTo(-ew / 2, 0); ctx.quadraticCurveTo(-ew * .1, -eh, 0, -eh); ctx.quadraticCurveTo(ew * .1, -eh, ew / 2, 0); ctx.closePath();
      ctx.fillStyle = '#3B3346'; ctx.fill();
      ctx.beginPath(); ctx.moveTo(-ew * .28, -eh * .08); ctx.quadraticCurveTo(0, -eh * .9, ew * .28, -eh * .08); ctx.closePath();
      ctx.fillStyle = '#FF9EC4'; ctx.fill();
      ctx.restore();
    });
    const [l, r] = eyes(F), nose = F.kp ? F.kp[2] : [F.cx, F.fy + F.fh * .58];
    ctx.fillStyle = 'rgba(255,110,160,.38)';
    [l, r].forEach(([ex, ey], i) => { ctx.beginPath(); ctx.ellipse(ex + (i ? 1 : -1) * F.fw * .06, ey + F.fh * .26, F.fw * .1, F.fh * .055, 0, 0, Math.PI * 2); ctx.fill(); });
    ctx.beginPath(); ctx.ellipse(nose[0], nose[1], F.fw * .055, F.fh * .035, 0, 0, Math.PI * 2); ctx.fillStyle = '#FF6FA5'; ctx.fill();
    ctx.strokeStyle = 'rgba(40,30,50,.85)'; ctx.lineWidth = Math.max(1, F.fw * .012); ctx.lineCap = 'round';
    [-1, 1].forEach(side => [-.06, 0, .06].forEach(dy => {
      ctx.beginPath(); ctx.moveTo(nose[0] + side * F.fw * .08, nose[1] + F.fh * .02);
      ctx.lineTo(nose[0] + side * F.fw * .42, nose[1] + F.fh * (dy * 1.6));
      ctx.stroke();
    }));
  },
  bunny(ctx, F, t) {
    [-1, 1].forEach(side => {
      ctx.save();
      ctx.translate(F.cx + side * F.fw * .2, F.top + F.fh * .22);
      ctx.rotate(side * .14 + Math.sin(t * 3 + side) * .07);
      const ew = F.fw * .23, eh = F.fh * 1.0;
      ctx.beginPath(); ctx.ellipse(0, -eh / 2, ew / 2, eh / 2, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#FFFFFF'; ctx.shadowColor = 'rgba(0,0,0,.25)'; ctx.shadowBlur = F.fw * .03; ctx.fill(); ctx.shadowBlur = 0;
      ctx.beginPath(); ctx.ellipse(0, -eh * .52, ew * .26, eh * .38, 0, 0, Math.PI * 2); ctx.fillStyle = '#FFB3CF'; ctx.fill();
      ctx.restore();
    });
    const nose = F.kp ? F.kp[2] : [F.cx, F.fy + F.fh * .58];
    heart(ctx, nose[0], nose[1], F.fw * .09, '#FF6FA5');
  },
  shades(ctx, F, t) {
    const [l, r] = eyes(F), d = Math.hypot(r[0] - l[0], r[1] - l[1]) || F.fw * .4;
    ctx.translate((l[0] + r[0]) / 2, (l[1] + r[1]) / 2);
    ctx.rotate(Math.atan2(r[1] - l[1], r[0] - l[0]));
    const lw = d * .95, lh = d * .62;
    const g = ctx.createLinearGradient(0, -lh / 2, 0, lh / 2);
    g.addColorStop(0, '#2A2F4A'); g.addColorStop(1, '#05060C');
    ctx.fillStyle = g; ctx.strokeStyle = '#111'; ctx.lineWidth = d * .06;
    [-1, 1].forEach(side => {
      ctx.beginPath(); ctx.roundRect(side * d * .52 - lw / 2, -lh / 2, lw, lh, lh * .35); ctx.fill(); ctx.stroke();
      ctx.save(); ctx.globalAlpha = .45 + .25 * Math.sin(t * 2);
      ctx.beginPath(); ctx.moveTo(side * d * .52 - lw * .3, -lh * .3); ctx.lineTo(side * d * .52 - lw * .05, -lh * .3); ctx.lineTo(side * d * .52 - lw * .3, lh * .1); ctx.closePath();
      ctx.fillStyle = '#FFFFFF'; ctx.fill(); ctx.restore();
    });
    ctx.beginPath(); ctx.moveTo(-d * .12, -lh * .2); ctx.quadraticCurveTo(0, -lh * .38, d * .12, -lh * .2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-d * .52 - lw / 2, -lh * .3); ctx.lineTo(-d * 1.2, -lh * .4); ctx.moveTo(d * .52 + lw / 2, -lh * .3); ctx.lineTo(d * 1.2, -lh * .4); ctx.stroke();
  },
  flowers(ctx, F, t) {
    const petals = ['#FF8FB8', '#FFFFFF', '#FFB86B', '#C59BFF', '#FF6FA5', '#FFFFFF', '#FF8FB8'];
    for (let i = 0; i < 9; i++) {
      const a = -1 + i * 2 / 8, x = F.cx + Math.sin(a) * F.fw * .6, y = F.top + F.fh * .28 + (1 - Math.cos(a)) * F.fh * .4;
      if (i < 8) {
        const a2 = a + 1 / 8;
        ctx.beginPath(); ctx.ellipse(F.cx + Math.sin(a2) * F.fw * .6, F.top + F.fh * .24 + (1 - Math.cos(a2)) * F.fh * .4, F.fw * .06, F.fw * .025, a2 + .6, 0, Math.PI * 2);
        ctx.fillStyle = '#4CB860'; ctx.fill();
      }
      flower(ctx, x, y, F.fw * (i % 2 ? .1 : .13), petals[i % petals.length], t * .6 + i);
    }
  },
  halo(ctx, F, t) {
    const y = F.top - F.fh * .08 + Math.sin(t * 2.4) * F.fh * .03;
    ctx.shadowColor = '#FFE98A'; ctx.shadowBlur = F.fw * .12;
    ctx.strokeStyle = '#FFE066'; ctx.lineWidth = F.fw * .065;
    ctx.beginPath(); ctx.ellipse(F.cx, y, F.fw * .4, F.fh * .1, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = '#FFFBEA'; ctx.lineWidth = F.fw * .02; ctx.stroke();
    for (let i = 0; i < 3; i++) {
      ctx.globalAlpha = Math.max(0, Math.sin(t * 3 + i * 2.1));
      star(ctx, F.cx + (i - 1) * F.fw * .55, y - F.fh * (.12 + .08 * (i % 2)), F.fw * .05, '#FFFFFF', 4, .3);
    }
  },
};
function fallY(i, t, h, speed) { return ((rand(i, 3) * 1.2 + t * speed) % 1.2 - .1) * h; }
const SCENE_FX = {
  confetti(ctx, w, h, t) {
    for (let i = 0; i < 80; i++) {
      ctx.save();
      ctx.translate(rand(i) * w + Math.sin(t * 2 + i) * w * .02, fallY(i, t, h, .12 + .1 * rand(i, 4)));
      ctx.rotate(t * (2 + 3 * rand(i, 5)) + i);
      ctx.scale(Math.cos(t * 5 + i), 1);
      ctx.fillStyle = PARTY_COLORS[i % PARTY_COLORS.length];
      ctx.fillRect(-w * .007, -w * .011, w * .014, w * .022);
      ctx.restore();
    }
  },
  bubbles(ctx, w, h, t) {
    for (let i = 0; i < 26; i++) {
      const r = w * (.015 + .03 * rand(i, 6)), x = rand(i) * w + Math.sin(t * 1.5 + i) * w * .03, y = h - fallY(i, t, h, .07 + .05 * rand(i, 4));
      const g = ctx.createRadialGradient(x - r * .3, y - r * .3, r * .1, x, y, r);
      g.addColorStop(0, 'rgba(255,255,255,.35)'); g.addColorStop(.7, 'rgba(160,220,255,.12)'); g.addColorStop(1, 'rgba(200,160,255,.45)');
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = g; ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.lineWidth = Math.max(1, r * .06); ctx.stroke();
      ctx.beginPath(); ctx.ellipse(x - r * .35, y - r * .4, r * .22, r * .12, -.7, 0, Math.PI * 2); ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.fill();
    }
  },
  snow(ctx, w, h, t) {
    ctx.fillStyle = '#FFFFFF';
    for (let i = 0; i < 110; i++) {
      const r = w * (.002 + .005 * rand(i, 6));
      ctx.globalAlpha = .55 + .45 * rand(i, 7);
      ctx.beginPath(); ctx.arc(rand(i) * w + Math.sin(t + i) * w * .02, fallY(i, t, h, .05 + .06 * rand(i, 4)), r, 0, Math.PI * 2); ctx.fill();
    }
  },
  sakura(ctx, w, h, t) {
    for (let i = 0; i < 45; i++) {
      ctx.save();
      ctx.translate(((rand(i) + t * .03) % 1) * w + Math.sin(t * 1.3 + i) * w * .03, fallY(i, t, h, .06 + .05 * rand(i, 4)));
      ctx.rotate(t * (1 + rand(i, 5)) + i);
      ctx.scale(1, .6 + .4 * Math.sin(t * 3 + i));
      ctx.beginPath(); ctx.ellipse(0, 0, w * .012, w * .007, 0, 0, Math.PI * 2);
      ctx.fillStyle = i % 3 ? '#FFB7D0' : '#FFD9E6'; ctx.fill();
      ctx.restore();
    }
  },
  balloons(ctx, w, h, t) {
    for (let i = 0; i < 12; i++) {
      const r = w * (.035 + .015 * rand(i, 6)), x = (i + .5) / 12 * w + Math.sin(t + i) * w * .02, y = h + r * 2 - fallY(i, t, h * 1.25, .05 + .03 * rand(i, 4));
      ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.lineWidth = Math.max(1, w * .002);
      ctx.beginPath(); ctx.moveTo(x, y + r * 1.15); ctx.quadraticCurveTo(x + Math.sin(t * 2 + i) * r * .6, y + r * 2.2, x, y + r * 3.4); ctx.stroke();
      ctx.beginPath(); ctx.ellipse(x, y, r * .86, r * 1.05, 0, 0, Math.PI * 2); ctx.fillStyle = PARTY_COLORS[i % PARTY_COLORS.length]; ctx.fill();
      ctx.beginPath(); ctx.ellipse(x - r * .3, y - r * .4, r * .16, r * .28, -.4, 0, Math.PI * 2); ctx.fillStyle = 'rgba(255,255,255,.55)'; ctx.fill();
    }
  },
  hearts(ctx, w, h, t) {
    for (let i = 0; i < 36; i++) {
      ctx.save();
      ctx.translate(rand(i) * w + Math.sin(t * 1.5 + i) * w * .025, fallY(i, t, h, .08 + .07 * rand(i, 4)));
      ctx.rotate(Math.sin(t * 2 + i) * .3);
      ctx.globalAlpha = .85;
      heart(ctx, 0, 0, w * (.025 + .03 * rand(i, 6)), HEART_COLORS[i % HEART_COLORS.length]);
      ctx.restore();
    }
  },
  stars(ctx, w, h, t) {
    ctx.shadowColor = '#FFF6B0'; ctx.shadowBlur = w * .01;
    for (let i = 0; i < 45; i++) {
      const k = Math.max(0, Math.sin(t * 2.6 + i * 1.37));
      if (k < .05) continue;
      star(ctx, rand(i) * w, rand(i, 8) * h, w * (.008 + .016 * rand(i, 6)) * k, i % 4 ? '#FFFFFF' : '#FFE45C', 4, .28);
    }
  },
  emoji(ctx, w, h, t) {
    const set = ['🥳', '😍', '🤩', '✨', '💖', '🎉', '😎', '🎓'];
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let i = 0; i < 22; i++) {
      ctx.save();
      ctx.translate(rand(i) * w, fallY(i, t, h, .07 + .05 * rand(i, 4)));
      ctx.rotate(Math.sin(t * 2 + i) * .35);
      ctx.font = `${Math.round(w * (.04 + .025 * rand(i, 6)))}px ${EMOJI_FONT}`;
      ctx.fillText(set[i % set.length], 0, 0);
      ctx.restore();
    }
  },
};

async function photoFx(i) {
  // The filtered version of photo i with its fun overlay on top, cached until the photo, filter or overlay changes.
  const f = filterById(state.filters[i]), layer = state.layers[i] || null;
  if (fxCache[i]?.id !== f.id || fxCache[i]?.layer !== layer) {
    const img = await loadImage(state.photos[i]);
    const size = fixedSize(f) ? FX_SIZE : { width: img.naturalWidth, height: img.naturalHeight };
    const canvas = f.id === 'normal' && !layer ? img : effectCanvas(img, f, size.width, size.height);
    if (layer) canvas.getContext('2d').drawImage(await loadImage(layer), 0, 0, canvas.width, canvas.height);
    fxCache[i] = { id: f.id, layer, canvas };
  }
  return fxCache[i].canvas;
}
async function setThumb(img, i) {
  // Small photo thumbnail that shows the photo's current filter and fun overlay.
  const f = filterById(state.filters[i]), photo = state.photos[i], layer = state.layers[i];
  img.src = photo;
  if ((f.id === 'normal' && !layer) || !photo) return;
  const source = await loadImage(photo);
  const canvas = effectCanvas(source, f, 320, 240);
  if (layer) canvas.getContext('2d').drawImage(await loadImage(layer), 0, 0, 320, 240);
  if (state.photos[i] === photo) img.src = canvas.toDataURL('image/jpeg', .85);
}
function refreshThumbs() { $$('img[data-photo]').forEach(img => setThumb(img, Number(img.dataset.photo))); }

/* ---------- Countdown sound (WebAudio, no files) ---------- */
function unlockAudio() {
  // Browsers only allow audio after a user gesture, so this runs from the shutter click.
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch { audioCtx = null; }
}
function soundOn() { return audioCtx && $('#sound-toggle').checked; }
function beep(final) {
  if (!soundOn()) return;
  const t = audioCtx.currentTime, osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
  osc.type = 'sine';
  osc.frequency.value = final ? 1320 : 880;
  gain.gain.setValueAtTime(.0001, t);
  gain.gain.exponentialRampToValueAtTime(.3, t + .01);
  gain.gain.exponentialRampToValueAtTime(.0001, t + (final ? .35 : .15));
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(t); osc.stop(t + .4);
}
function shutterSound() {
  if (!soundOn()) return;
  const length = Math.floor(audioCtx.sampleRate * .12);
  const buffer = audioCtx.createBuffer(1, length, audioCtx.sampleRate), data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 3;
  const source = audioCtx.createBufferSource(), gain = audioCtx.createGain();
  gain.gain.value = .5;
  source.buffer = buffer;
  source.connect(gain).connect(audioCtx.destination);
  source.start();
}

function showStep(name) {
  state.step = name;
  for (const pane of ['register','template','camera','review','result']) {
    $(`#pane-${pane}`).hidden = pane !== name;
  }
  document.body.dataset.step = name;
  $('#toast').hidden = true;
  const order = ['register','template','camera','result'];
  const current = order.indexOf(name === 'review' ? 'camera' : name);
  $$('.step').forEach((element, i) => {
    element.classList.toggle('active', i === current);
    element.classList.toggle('done', i < current);
    if (i === current) element.setAttribute('aria-current', 'step');
    else element.removeAttribute('aria-current');
  });
  $(`#pane-${name} [data-focus]`)?.focus({ preventScroll: true });
  window.scrollTo({ top: 0 });
  if (name === 'result') startIdle(); else stopIdle();
  if (name === 'camera') { renderLiveEffects(); applyLiveFilter(); }
}
async function apiGet(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Kesalahan server (${response.status})`);
  return await response.json();
}

/* ---------- Templates ---------- */
async function loadTemplates() {
  const container = $('#template-grid');
  container.dataset.state = 'loading';
  container.replaceChildren(...Array.from({ length: 4 }, () => Object.assign(document.createElement('div'), { className: 'template-skeleton' })));
  try {
    state.templates = await apiGet(`${BASE}/api/templates`);
  } catch (e) {
    container.dataset.state = 'error';
    const box = document.createElement('div');
    box.className = 'grid-message';
    box.innerHTML = `${icon('i-alert')}<p>Daftar frame belum bisa dimuat. Pastikan server photobooth menyala, lalu muat ulang.</p><button type="button" class="btn btn-primary">${icon('i-refresh')}<span>Muat ulang frame</span></button>`;
    box.querySelector('button').addEventListener('click', () => loadTemplates().catch(() => {}));
    container.replaceChildren(box);
    throw e;
  }
  container.dataset.state = 'ready';
  const rows = state.templates.length > 8 ? 2 : 1; // more than 8 frames: two rows so cards stay readable
  container.style.setProperty('--rows', rows);
  container.style.setProperty('--count', Math.ceil(state.templates.length / rows));
  container.dataset.rows = rows;
  container.replaceChildren();
  for (const template of state.templates) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'template-card';
    card.dataset.template = template.id;
    card.setAttribute('aria-pressed', 'false');
    card.innerHTML = `<span class="poster"><img alt="" decoding="async"/><span class="check">${icon('i-check')}</span></span><span class="name"></span><span class="desc"></span>`;
    card.querySelector('img').src = template.preview;
    card.querySelector('.name').textContent = template.title;
    card.querySelector('.desc').textContent = template.desc;
    card.addEventListener('click', () => selectTemplate(template));
    container.append(card);
  }
  $('#hero-fan').replaceChildren(...state.templates.slice(0, 4).map(t => Object.assign(new Image(), { src: t.preview, alt: '' })));
}
function selectTemplate(template) {
  state.template = template;
  state.templateImage = null;
  // Start fetching the full-size overlay now so the camera step opens faster.
  state.artPromise = loadImage(template.asset);
  state.artPromise.catch(() => {});
  $$('.template-card').forEach(node => node.setAttribute('aria-pressed', String(node.dataset.template === template.id)));
  $('#template-next').disabled = false;
}
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Gagal memuat template.'));
    img.src = src;
  });
}

/* ---------- Camera ---------- */
function setCameraMessage(text, { busy = true } = {}) {
  const box = $('#camera-message');
  box.hidden = false;
  box.classList.toggle('busy', busy);
  $('#camera-message-text').textContent = text;
  $('#camera-actions').hidden = busy;
}
function showCameraError(message) {
  stopCamera();
  setCameraMessage(message, { busy: false });
  updateCaptureHeading();
}
function stopCamera() {
  if (state.videoStream) {
    for (const track of state.videoStream.getTracks()) { track.onended = null; track.stop(); }
    state.videoStream = null;
  }
  $('#camera-video').srcObject = null;
}
async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Browser tidak mendukung kamera. Jalankan melalui localhost atau HTTPS.');
  }
  stopCamera();
  setCameraMessage('Menyalakan kamera… Jika browser bertanya, pilih Izinkan.');
  const constraints = {
    audio: false,
    video: { facingMode: 'user', width: { ideal: 1920 }, height: { ideal: 1440 }, aspectRatio: { ideal: 4 / 3 } },
  };
  try {
    state.videoStream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (e) {
    if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
      throw new Error('Akses kamera ditolak. Klik ikon kamera di bilah alamat browser, pilih Izinkan, lalu tekan Coba lagi.');
    }
    if (e.name === 'NotFoundError') throw new Error('Kamera tidak ditemukan. Pastikan webcam tersambung, lalu tekan Coba lagi.');
    if (e.name === 'NotReadableError') throw new Error('Kamera sedang dipakai aplikasi lain. Tutup aplikasi itu, lalu tekan Coba lagi.');
    throw new Error('Tidak dapat membuka kamera: ' + e.message);
  }
  for (const track of state.videoStream.getVideoTracks()) track.onended = onCameraLost;
  const video = $('#camera-video');
  video.srcObject = state.videoStream;
  await video.play();
  $('#camera-message').hidden = true;
  applyLiveFilter();
}
function onCameraLost() {
  if (!['camera', 'review'].includes(state.step)) return;
  countdownAbort = true;
  showCameraError('Kamera terputus. Periksa kabel webcam, lalu tekan Coba lagi. Foto yang sudah diambil tetap aman.');
}
async function retryCamera() {
  try {
    setCameraMessage('Menyiapkan frame…');
    if (!state.templateImage) {
      state.templateImage = await loadImage(state.template.asset);
      setupLivePoster();
    }
    await startCamera();
    if (!state.endsAt) startSessionClock();
    updateCaptureHeading();
  } catch (e) { showCameraError(e.message); }
}

/* ---------- Session clock ---------- */
function renderTimer(remaining) {
  const text = humanTime(remaining);
  const urgent = state.endsAt > 0 && remaining <= 20;
  $('#session-timer strong').textContent = text;
  $('#session-timer').style.setProperty('--left', String(Math.min(1, remaining / SESSION_SECONDS)));
  $('#session-timer').classList.toggle('urgent', urgent);
  $('#review-time').textContent = text;
  $('#review-timer').classList.toggle('urgent', urgent);
}
function startSessionClock() {
  state.endsAt = Date.now() + SESSION_SECONDS * 1000;
  clearInterval(state.interval);
  state.interval = setInterval(onTimerTick, 200);
  onTimerTick();
}
function onTimerTick() {
  if (!state.endsAt) return;
  const remaining = timeRemaining();
  renderTimer(remaining);
  if (remaining > 0) return;
  clearInterval(state.interval);
  countdownAbort = true;
  if (state.step === 'camera') {
    $('#countdown').hidden = true;
    updateCaptureHeading();
    toast(allPhotosReady() ? 'Waktu sesi habis. Kamu masih bisa melanjutkan ke hasil.' : `Waktu 2 menit habis. Tekan Ulang sesi untuk mengambil ${shotCount()} foto lagi.`, 'error');
  }
  if (state.step === 'review') {
    $$('.retake').forEach(button => button.disabled = true);
    $('#review-expired').hidden = false;
  }
}

/* ---------- Capture screen ---------- */
function renderCameraSlots() {
  const container = $('#shot-slots');
  container.replaceChildren();
  container.style.setProperty('--n', state.photos.length);
  state.photos.forEach((photo, i) => {
    const shot = document.createElement('div');
    shot.className = 'shot-slot';
    shot.classList.toggle('next', i === state.currentShot && !sessionExpired());
    const tag = document.createElement('span'); tag.className = 'tag';
    if (photo) {
      const img = document.createElement('img'); img.alt = `Foto ${i + 1}`; img.dataset.photo = i; setThumb(img, i); shot.append(img);
      tag.textContent = `${i + 1}`;
      shot.append(tag);
    } else shot.textContent = i + 1;
    container.append(shot);
  });
}
function updateCropGuide() {
  const slot = state.template?.slots[state.currentShot];
  if (!slot) return;
  // The 4:3 shot is cover-fitted into the slot, so show which centre band survives the crop.
  const slotAspect = slot.w / slot.h, camAspect = 4 / 3;
  const guide = $('#crop-guide');
  guide.style.setProperty('--gw', slotAspect >= camAspect ? '100%' : `${slotAspect / camAspect * 100}%`);
  guide.style.setProperty('--gh', slotAspect >= camAspect ? `${camAspect / slotAspect * 100}%` : '100%');
}
function placeSlotMarks(container, template) {
  container.replaceChildren(...template.slots.map((s, i) => {
    const mark = document.createElement('span');
    mark.className = 'slot-mark';
    mark.dataset.slot = i;
    Object.assign(mark.style, {
      left: `${s.x / template.artWidth * 100}%`, top: `${s.y / template.artHeight * 100}%`,
      width: `${s.w / template.artWidth * 100}%`, height: `${s.h / template.artHeight * 100}%`,
    });
    return mark;
  }));
}
function setupLivePoster() {
  const t = state.template;
  const canvas = $('#live-poster');
  canvas.width = Math.round(t.artWidth / 2);
  canvas.height = Math.round(t.artHeight / 2);
  placeSlotMarks($('#live-marks'), t);
}
async function drawLivePoster() {
  const t = state.template, art = state.templateImage, canvas = $('#live-poster');
  $$('#live-marks .slot-mark').forEach((m, i) => m.classList.toggle('current', i === state.currentShot && !sessionExpired()));
  if (!t || !art) return;
  const token = ++state.liveDraw;
  const imgs = await Promise.all(state.photos.map((p, i) => p ? photoFx(i) : null));
  if (token !== state.liveDraw) return;
  const ctx = canvas.getContext('2d');
  const sx = canvas.width / t.artWidth, sy = canvas.height / t.artHeight;
  ctx.fillStyle = '#DCE2F5'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  t.slots.forEach((s, i) => {
    const box = { x: s.x * sx, y: s.y * sy, w: s.w * sx, h: s.h * sy, r: 0, clip: scaleClip(s, sx, sy) };
    if (imgs[i]) drawImageCover(ctx, imgs[i], box);
    else {
      ctx.fillStyle = '#97A3CF'; ctx.font = `800 ${Math.round(box.h * .4)}px "Bricolage Grotesque", sans-serif`;
      ctx.fillText(String(i + 1), box.x + box.w / 2, box.y + box.h / 2);
    }
  });
  ctx.drawImage(art, 0, 0, canvas.width, canvas.height);
}
function updateCaptureHeading() {
  const number = state.currentShot + 1, total = shotCount();
  const expired = sessionExpired();
  $('#capture-title').textContent = state.retaking ? `Ulangi foto ${number}` : `Foto ${number} dari ${total}`;
  const taken = state.photos.filter(Boolean).length;
  let label = taken ? `Lanjutkan foto ${number}` : 'Mulai foto';
  if (state.retaking) label = `Ulangi foto ${number}`;
  if (expired) label = 'Waktu habis';
  if (state.countingDown) label = 'Berhenti';
  $('#capture-label').textContent = label;
  $('#capture-button').classList.toggle('is-stop', state.countingDown);
  $('#hud-shot').textContent = `Foto ${number}, jendela ${slotName(state.currentShot)}`;
  $('#capture-button').disabled = expired || (!state.countingDown && (timeRemaining() < 6 || !state.videoStream));
  const reviewButton = $('#review-button');
  reviewButton.hidden = !(allPhotosReady() && !state.countingDown);
  reviewButton.querySelector('span').textContent = state.retaking && !expired ? 'Batal ulangi' : 'Lihat hasil';
  $('#restart-button').hidden = !(expired && !allPhotosReady());
  $('#change-frame').hidden = state.countingDown;
  $$('#live-effects button').forEach(b => b.disabled = state.countingDown);
  let status = taken ? `Tekan Lanjutkan untuk memotret foto ${number} sampai ${total}.` : `Tekan Mulai foto sekali. Kamera memotret ${total} kali otomatis, hitung mundur ${SHOT_COUNTDOWN} detik tiap foto.`;
  if (state.countingDown) status = `Foto ${number} dari ${total}, tahan pose… Tekan Berhenti untuk jeda.`;
  else if (expired) status = allPhotosReady() ? 'Waktu habis. Lanjutkan ke hasil untuk menyimpan foto.' : `Waktu habis sebelum ${total} foto selesai. Tekan Ulang sesi untuk mencoba lagi.`;
  else if (state.retaking) status = `Foto ${number} akan diganti. Foto lain tidak berubah.`;
  $('#camera-status').textContent = status;
  document.body.classList.toggle('counting', state.countingDown);
  renderCameraSlots();
  updateCropGuide();
  drawLivePoster();
}
async function createNewSession() {
  countdownAbort = true;
  clearInterval(state.interval);
  state.endsAt = 0;
  state.photos = Array(shotCount()).fill(null);
  state.currentShot = 0;
  state.retaking = false;
  state.countingDown = false;
  resetEdits();
  showStep('camera');
  setCameraMessage('Menyiapkan frame…');
  renderTimer(SESSION_SECONDS);
  try {
    state.templateImage = await (state.artPromise || loadImage(state.template.asset));
    setupLivePoster();
    updateCaptureHeading();
    await startCamera();
  } catch (e) { showCameraError(e.message); return; }
  startSessionClock();
  updateCaptureHeading();
}
function captureVideoFrame() {
  const video = $('#camera-video');
  if (video.readyState < 2 || !video.videoWidth) throw new Error('Video kamera belum siap.');
  const c = blankCanvas(1600, 1200); // 4:3 per shot, always raw — filters and fun overlays are applied at render time
  const ctx = c.getContext('2d', { alpha: false });
  if ($('#mirror-camera').checked) { ctx.translate(c.width, 0);ctx.scale(-1, 1); }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  drawImageCover(ctx, video, { x: 0, y: 0, w: c.width, h: c.height, r: 0 });
  return c.toDataURL('image/jpeg', .95);
}
function captureOverlayLayer() {
  // The fun overlay at this exact moment, as a transparent layer mirrored like the photo; null without one.
  if (state.liveOverlay === 'none') return null;
  const c = blankCanvas(1600, 1200), ctx = c.getContext('2d');
  if ($('#mirror-camera').checked) { ctx.translate(c.width, 0); ctx.scale(-1, 1); }
  drawOverlay(ctx, c.width, c.height, state.liveOverlay, performance.now() / 1000);
  return c.toDataURL('image/png');
}
function restartAnimation(element, className) {
  element.classList.remove(className); void element.offsetWidth; element.classList.add(className);
}
// One press shoots every missing photo in a row (countdown → capture → quick look → next).
// While it runs the shutter button is a stop button; a retake shoots just that one photo.
async function countdownAndShoot() {
  if (state.countingDown) { stopRequested = true; countdownAbort = true; return; }
  if (timeRemaining() < SHOT_COUNTDOWN + .6 || !state.videoStream) {
    toast('Waktu tidak cukup atau kamera belum siap.', 'error'); return;
  }
  unlockAudio();
  if (!$('#effect-grid').hidden) closeEffectGrid();
  state.countingDown = true;
  countdownAbort = false;
  stopRequested = false;
  const display = $('#countdown');
  const cancelled = () => new Error(stopRequested
    ? 'Foto otomatis dihentikan. Foto yang sudah diambil tetap tersimpan.'
    : timeRemaining() <= 0 ? 'Waktu sesi sudah habis.' : 'Hitung mundur dibatalkan.');
  try {
    for (;;) {
      if (timeRemaining() < SHOT_COUNTDOWN + .6) throw new Error('Waktu sesi tidak cukup untuk foto berikutnya.');
      updateCaptureHeading();
      for (let sec = SHOT_COUNTDOWN; sec > 0; sec--) {
        if (countdownAbort || timeRemaining() <= 0) throw cancelled();
        display.hidden = false;
        $('#countdown-num').textContent = sec;
        restartAnimation(display, 'tick');
        beep(sec === 1);
        await sleep(1000);
      }
      if (countdownAbort || timeRemaining() <= 0) throw cancelled();
      display.hidden = true;
      const shot = state.currentShot;
      state.photos[shot] = captureVideoFrame();
      state.layers[shot] = captureOverlayLayer();
      state.filters[shot] = state.liveFilter;
      state.overlays[shot] = state.liveOverlay;
      fxCache[shot] = null;
      shutterSound();
      restartAnimation($('#flash'), 'go');
      if (state.retaking || allPhotosReady()) break;
      state.currentShot = state.photos.findIndex(photo => !photo);
      await showShotPreview(shot);
      if (countdownAbort) throw cancelled();
    }
    await sleep(450);
    state.retaking = false;
    await showReview();
  } catch(e) { toast(e.message, stopRequested ? 'info' : 'error'); }
  finally {
    display.hidden = true;
    $('#shot-preview').hidden = true;
    state.countingDown = false;
    stopRequested = false;
    if (state.step === 'camera') updateCaptureHeading();
  }
}
async function showShotPreview(shot) {
  const box = $('#shot-preview');
  setThumb(box.querySelector('img'), shot);
  box.querySelector('span').textContent = `Foto ${shot + 1} tersimpan`;
  box.hidden = false;
  restartAnimation(box, 'show');
  updateCaptureHeading();
  $('#camera-status').textContent = `Foto ${shot + 1} tersimpan. Bersiap untuk foto ${state.currentShot + 1}…`;
  await sleep(SHOT_PREVIEW_MS);
  box.hidden = true;
}
function changeFrame(event) {
  const button = event.currentTarget;
  // Two taps when photos exist, so a stray touch never throws away a session.
  if (state.photos.some(Boolean) && !button.classList.contains('armed')) {
    button.classList.add('armed');
    button.querySelector('span').textContent = 'Tekan lagi, foto akan dihapus';
    clearTimeout(state.frameArmTimer);
    state.frameArmTimer = setTimeout(disarmChangeFrame, 3500);
    return;
  }
  disarmChangeFrame();
  countdownAbort = true;
  clearInterval(state.interval);
  state.endsAt = 0;
  state.photos = Array(shotCount()).fill(null);
  stopCamera();
  showStep('template');
}
function disarmChangeFrame() {
  clearTimeout(state.frameArmTimer);
  $$('#change-frame, #camera-back').forEach(button => {
    button.classList.remove('armed');
    button.querySelector('span').textContent = 'Ganti frame';
  });
}

/* ---------- Compositing ---------- */
// Staggered/tilted frames carry a window polygon so a photo never paints into the neighbouring window.
function scaleClip(slot, sx, sy) { return slot.clip?.map(([x, y]) => [x * sx, y * sy]); }
function drawImageCover(ctx, img, box, filter = 'none') {
  const { x, y, w, h, r, clip } = box;
  const frameAspect = w / h;
  // Works for <img>, <video> and <canvas> sources.
  const iw = img.naturalWidth || img.videoWidth || img.width, ih = img.naturalHeight || img.videoHeight || img.height;
  let sx = 0, sy = 0, sw = iw, sh = ih;
  if (iw / ih > frameAspect) { sw = ih * frameAspect; sx = (iw - sw) / 2; }
  else { sh = iw / frameAspect; sy = (ih - sh) / 2; }
  ctx.save();ctx.beginPath();
  if (clip) clip.forEach(([px, py], i) => i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)); // tilted window outline
  else if (r && typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
  ctx.clip();
  if (filter !== 'none') ctx.filter = filter;
  ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
  ctx.restore();
}
async function renderPoster(width, height, { stickers = true } = {}) {
  if (!allPhotosReady()) throw new Error('Semua foto harus diambil terlebih dahulu.');
  const template = state.template;
  const art = state.templateImage || await loadImage(template.asset);
  const imgs = await Promise.all(state.photos.map((_, i) => photoFx(i)));
  const canvas = document.createElement('canvas');
  canvas.width = width;canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false });
  const sx = width / template.artWidth, sy = height / template.artHeight;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = true;ctx.imageSmoothingQuality = 'high';
  template.slots.forEach((slot, index) => {
    drawImageCover(ctx, imgs[index], {
      x: slot.x * sx, y: slot.y * sy,
      w: slot.w * sx, h: slot.h * sy, r: slot.r * (sx + sy) / 2, clip: scaleClip(slot, sx, sy),
    });
  });
  // The frame casts a soft shadow into each window, so photos sit inside the art instead of looking pasted on.
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, .42)';
  ctx.shadowBlur = 6 * (sx + sy);
  ctx.shadowOffsetY = 2 * sy;
  ctx.drawImage(art, 0, 0, width, height);
  ctx.restore();
  if (stickers) await drawStickers(ctx, width, height);
  return canvas;
}

/* ---------- Review ---------- */
async function showReview() {
  if (!allPhotosReady()) return;
  state.retaking = false;
  showStep('review');
  const template = state.template;
  const canRetake = timeRemaining() >= 6;
  placeSlotMarks($('#review-marks'), template);
  const reviewList = $('#review-shots');
  reviewList.replaceChildren();
  reviewList.dataset.count = state.photos.length;
  state.photos.forEach((_, i) => {
    const item = document.createElement('div'); item.className = 'review-shot';
    const img = document.createElement('img'); img.dataset.photo = i; setThumb(img, i); img.alt = `Foto ${i + 1}`;
    const details = document.createElement('div');
    const b = document.createElement('b'); b.textContent = `Foto ${i + 1}`;
    const where = document.createElement('span'); where.textContent = `Jendela ${slotName(i)}`;
    details.append(b, where);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'retake btn btn-ghost';
    button.innerHTML = `${icon('i-refresh')}<span>Ulangi</span>`;
    button.setAttribute('aria-label', `Ulangi foto ${i + 1}`);
    button.disabled = !canRetake;
    button.addEventListener('click', async () => {
      if (timeRemaining() < 6) { toast('Waktu ulang foto tidak mencukupi.', 'error'); return; }
      state.currentShot = i; state.retaking = true;
      state.liveFilter = state.filters[i]; // camera opens with this photo's effect
      state.liveOverlay = state.overlays[i] || 'none';
      showStep('camera'); updateCaptureHeading();
    });
    const mark = (on) => $(`#review-marks [data-slot="${i}"]`)?.classList.toggle('hover', on);
    item.addEventListener('pointerenter', () => mark(true));
    item.addEventListener('pointerleave', () => mark(false));
    item.addEventListener('focusin', () => mark(true));
    item.addEventListener('focusout', () => mark(false));
    item.append(img, details, button);
    reviewList.append(item);
  });
  $('#review-expired').hidden = canRetake;
  selectReviewTab('shots');
  state.filterTarget = -1;
  renderFilterTab();
  renderStickers();
  const canvas = $('#preview-canvas');
  canvas.width = 720;
  canvas.height = Math.round(720 * template.artHeight / template.artWidth);
  await renderPreview();
  onTimerTick();
}
async function renderPreview() {
  const canvas = $('#preview-canvas');
  const token = ++state.liveDraw;
  const composite = await renderPoster(canvas.width, canvas.height, { stickers: false }); // stickers are DOM while editing
  if (token === state.liveDraw) canvas.getContext('2d').drawImage(composite, 0, 0);
}

/* ---------- Filters & stickers ---------- */
function selectReviewTab(name) {
  $$('.review-tab').forEach(tab => tab.setAttribute('aria-selected', String(tab.dataset.tab === name)));
  $$('.review-panel').forEach(panel => panel.hidden = panel.dataset.panel !== name);
}
function setPhotoFilter(id) {
  state.photos.forEach((_, i) => { if (state.filterTarget < 0 || state.filterTarget === i) state.filters[i] = id; });
  renderFilterTab();
  refreshThumbs();
  renderPreview();
}
function renderFilterTab() {
  // Target row: "Semua" or one photo; the grid previews every filter on that photo.
  const target = state.filterTarget;
  const all = Object.assign(document.createElement('button'), { type: 'button', className: 'target-chip target-all', textContent: 'Semua' });
  all.setAttribute('aria-pressed', String(target < 0));
  all.addEventListener('click', () => { state.filterTarget = -1; renderFilterTab(); });
  $('#filter-target').replaceChildren(all, ...state.photos.map((_, i) => {
    const button = Object.assign(document.createElement('button'), { type: 'button', className: 'target-chip' });
    button.setAttribute('aria-pressed', String(target === i));
    button.setAttribute('aria-label', `Filter untuk foto ${i + 1}`);
    const img = new Image(); img.alt = ''; img.dataset.photo = i; setThumb(img, i);
    const tag = Object.assign(document.createElement('span'), { textContent: i + 1 });
    button.append(img, tag);
    button.addEventListener('click', () => { state.filterTarget = i; renderFilterTab(); });
    return button;
  }));
  const index = Math.max(0, target);
  const current = target < 0 ? (state.filters.every(id => id === state.filters[0]) ? state.filters[0] : null) : state.filters[target];
  const grid = $('#filter-grid');
  const chips = FILTERS.map(f => {
    const button = Object.assign(document.createElement('button'), { type: 'button', className: 'filter-chip' });
    button.setAttribute('aria-pressed', String(f.id === current));
    const img = new Image(); img.alt = '';
    const label = document.createElement('span'); label.textContent = f.label;
    button.append(img, label);
    button.addEventListener('click', () => setPhotoFilter(f.id));
    return button;
  });
  grid.replaceChildren(...chips);
  const photo = state.photos[index];
  loadImage(photo).then(source => {
    if (state.photos[index] !== photo || grid.firstChild !== chips[0]) return;
    FILTERS.forEach((f, i) => { chips[i].querySelector('img').src = effectCanvas(source, f, 160, 120).toDataURL('image/jpeg', .8); });
  }).catch(() => {});
}

/* ---------- Live camera effect ---------- */
function renderLiveEffects() {
  // Strip: "Semua efek" (3×3 grid) + every filter and fun overlay, grouped like the grid pages.
  const chip = (label, pressed, onClick, extra = '') => {
    const button = Object.assign(document.createElement('button'), { type: 'button', className: `effect-chip ${extra}`, textContent: label });
    button.setAttribute('aria-pressed', String(pressed));
    button.disabled = state.countingDown;
    button.addEventListener('click', onClick);
    return button;
  };
  const heading = text => Object.assign(document.createElement('span'), { className: 'effect-group', textContent: text });
  const all = chip('▦ Semua efek', false, openEffectGrid, 'effect-all');
  all.removeAttribute('aria-pressed');
  const items = [all, chip('Normal', state.liveFilter === 'normal' && state.liveOverlay === 'none', () => {
    state.liveFilter = 'normal'; state.liveOverlay = 'none'; renderLiveEffects(); applyLiveFilter();
  })];
  for (const page of EFFECT_PAGES) {
    items.push(heading(page.label));
    if (page.kind === 'filter') {
      for (const f of FILTERS.filter(f => f.group === page.id)) items.push(chip(f.label, f.id === state.liveFilter, () => selectLiveEffect('filter', f.id)));
    } else {
      for (const o of OVERLAYS.filter(o => o.group === page.id)) items.push(chip(`${o.icon} ${o.label}`, o.id === state.liveOverlay, () => selectLiveEffect('overlay', o.id === state.liveOverlay ? 'none' : o.id)));
    }
  }
  $('#live-effects').replaceChildren(...items);
}
function selectLiveEffect(kind, id) {
  if (kind === 'filter') state.liveFilter = id; else state.liveOverlay = id;
  renderLiveEffects(); applyLiveFilter();
}
function liveNeedsCanvas() { return fixedSize(filterById(state.liveFilter)) || state.liveOverlay !== 'none'; }
function applyLiveFilter() {
  // Plain CSS filters style the <video> directly; distortions, pixel effects and fun overlays are redrawn
  // every frame into a canvas over it (video → effect → overlay, the same order as the finished photo).
  const f = filterById(state.liveFilter), canvasMode = liveNeedsCanvas();
  $('#camera-video').style.filter = canvasMode ? '' : filterCss(f, 1.5);
  $('#live-effect').hidden = !canvasMode;
  if (overlayById(state.liveOverlay).group === 'face') loadFaceDetector();
  cancelAnimationFrame(liveFxRaf);
  liveFxRaf = canvasMode ? requestAnimationFrame(liveFxLoop) : 0;
}
const liveSource = blankCanvas(LIVE_FX_SIZE.width, LIVE_FX_SIZE.height);
function drawLiveSource(detect) {
  // Unmirrored 4:3 video frame; face detection runs on it when a face overlay needs it.
  const ctx = liveSource.getContext('2d', { willReadFrequently: true });
  drawImageCover(ctx, $('#camera-video'), { x: 0, y: 0, w: liveSource.width, h: liveSource.height, r: 0 });
  if (detect) detectFaces(liveSource);
  return liveSource;
}
function liveFxLoop(now) {
  const video = $('#camera-video');
  if (!liveNeedsCanvas() || state.step !== 'camera' || !state.videoStream) { liveFxRaf = 0; return; }
  if (video.readyState >= 2 && $('#effect-grid').hidden) {
    const out = $('#live-effect'), { width, height } = LIVE_FX_SIZE;
    effectCanvas(drawLiveSource(overlayById(state.liveOverlay).group === 'face'), filterById(state.liveFilter), width, height, out);
    drawOverlay(out.getContext('2d'), width, height, state.liveOverlay, now / 1000); // overlay stays crisp on top of the effect
  }
  liveFxRaf = requestAnimationFrame(liveFxLoop);
}

/* ---------- 3×3 effect grid, like Photo Booth on a Mac ---------- */
const TILE = { width: 240, height: 180 };
const tileSource = blankCanvas(TILE.width, TILE.height);
let gridRaf = 0, gridLast = 0;
function pageItems(page) {
  const list = page.kind === 'filter' ? FILTERS : OVERLAYS;
  const items = list.filter(item => item.group === page.id).slice(0, 8);
  return [...items.slice(0, 4), list[0], ...items.slice(4)]; // Normal / no overlay in the middle
}
function openEffectGrid() {
  if (state.countingDown) return;
  $('#effect-grid').hidden = false;
  renderEffectGrid();
  cancelAnimationFrame(gridRaf);
  gridRaf = requestAnimationFrame(gridLoop);
}
function closeEffectGrid() {
  $('#effect-grid').hidden = true;
  cancelAnimationFrame(gridRaf); gridRaf = 0;
  applyLiveFilter();
}
function renderEffectGrid() {
  const page = EFFECT_PAGES.find(p => p.id === state.effectPage) || EFFECT_PAGES[0];
  if (page.id === 'face') loadFaceDetector();
  $('#effect-tabs').replaceChildren(...EFFECT_PAGES.map(p => {
    const tab = Object.assign(document.createElement('button'), { type: 'button', className: 'effect-tab', textContent: p.label });
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(p.id === page.id));
    tab.addEventListener('click', () => { state.effectPage = p.id; renderEffectGrid(); });
    return tab;
  }));
  $('#effect-tiles').replaceChildren(...pageItems(page).map(item => {
    const tile = Object.assign(document.createElement('button'), { type: 'button', className: 'effect-tile' });
    const current = page.kind === 'filter' ? state.liveFilter : state.liveOverlay;
    tile.setAttribute('aria-pressed', String(item.id === current));
    const canvas = blankCanvas(TILE.width, TILE.height);
    const label = document.createElement('span');
    label.textContent = item.id === 'none' ? 'Normal' : item.label;
    tile.append(canvas, label);
    tile.addEventListener('click', () => { selectLiveEffect(page.kind, item.id); closeEffectGrid(); });
    return tile;
  }));
}
function gridLoop(now) {
  const video = $('#camera-video');
  if ($('#effect-grid').hidden || state.step !== 'camera' || !state.videoStream) { gridRaf = 0; return; }
  gridRaf = requestAnimationFrame(gridLoop);
  if (now - gridLast < 80 || video.readyState < 2) return; // ~12 fps is plenty for nine previews
  gridLast = now;
  const page = EFFECT_PAGES.find(p => p.id === state.effectPage) || EFFECT_PAGES[0], items = pageItems(page), t = now / 1000;
  const source = tileSource.getContext('2d', { willReadFrequently: true });
  if (page.id === 'face') source.drawImage(drawLiveSource(true), 0, 0, TILE.width, TILE.height); // also runs face detection
  else drawImageCover(source, video, { x: 0, y: 0, w: TILE.width, h: TILE.height, r: 0 });
  $$('#effect-tiles canvas').forEach((canvas, i) => {
    const item = items[i];
    if (!item) return;
    if (page.kind === 'filter') { effectCanvas(tileSource, item, TILE.width, TILE.height, canvas); return; }
    const ctx = canvas.getContext('2d');
    ctx.drawImage(tileSource, 0, 0);
    drawOverlay(ctx, TILE.width, TILE.height, item.id, t);
  });
}

/* ---------- Stickers ---------- */
function stickerArt(src) {
  if (!artCache.has(src)) artCache.set(src, loadImage(src));
  return artCache.get(src);
}
function stickerName(s) {
  if (s.emoji) return s.emoji;
  return decodeURIComponent(s.src.split('/').pop().split('?')[0]).replace(/^\d+[-_ ]*/, '').replace(/\.\w+$/, '').replace(/[-_]+/g, ' ');
}
async function drawStickers(ctx, width, height) {
  const arts = await Promise.all(state.stickers.map(s => s.src ? stickerArt(s.src).catch(() => null) : null));
  ctx.save();
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  state.stickers.forEach((s, i) => {
    const size = s.size * width;
    ctx.save();
    ctx.translate(s.x * width, s.y * height);
    ctx.rotate(s.rot * Math.PI / 180);
    if (arts[i]) ctx.drawImage(arts[i], -size / 2, -size * arts[i].naturalHeight / arts[i].naturalWidth / 2, size, size * arts[i].naturalHeight / arts[i].naturalWidth);
    else if (s.emoji) { ctx.font = `${Math.round(size)}px ${EMOJI_FONT}`; ctx.fillText(s.emoji, 0, 0); }
    ctx.restore();
  });
  ctx.restore();
}
function addSticker(art) {
  if (state.stickers.length >= MAX_STICKERS) { toast(`Maksimal ${MAX_STICKERS} stiker. Hapus salah satu dulu.`, 'error'); return; }
  const n = state.stickers.length;
  state.stickers.push({ ...art, x: .5 + (n % 3 - 1) * .12, y: .5 + (Math.floor(n / 3) % 3 - 1) * .1, size: art.src ? .24 : .14, rot: 0 });
  state.selectedSticker = state.stickers.length - 1;
  renderStickers();
}
function selectSticker(index) {
  state.selectedSticker = index;
  $$('#sticker-layer .sticker').forEach((el, i) => el.classList.toggle('selected', i === index));
  const s = state.stickers[index];
  ['#sticker-smaller', '#sticker-bigger', '#sticker-rotl', '#sticker-rotr', '#sticker-delete'].forEach(id => $(id).disabled = !s);
  $('#sticker-tools-label').textContent = s ? `Stiker ${stickerName(s)} dipilih` : 'Pilih stiker di foto untuk mengubahnya';
  placeStickerX();
}
function placeStickerX() {
  // Quick-delete handle at the selected sticker's top-right corner.
  const s = state.stickers[state.selectedSticker], x = $('#sticker-x');
  x.hidden = !s;
  if (!s) return;
  const layer = $('#sticker-layer'), half = s.size * layer.clientWidth * .55;
  x.style.left = `${s.x * layer.clientWidth + half}px`;
  x.style.top = `${s.y * layer.clientHeight - half}px`;
}
function placeSticker(el, s) {
  el.style.left = `${s.x * 100}%`;
  el.style.top = `${s.y * 100}%`;
  el.style.setProperty('--size', s.size);
  el.style.setProperty('--rot', `${s.rot}deg`);
  if (s === state.stickers[state.selectedSticker]) placeStickerX();
}
function renderStickers() {
  $('#sticker-layer').replaceChildren(...state.stickers.map((s, i) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'sticker';
    if (s.src) el.append(Object.assign(new Image(), { src: s.src, alt: '', draggable: false }));
    else el.textContent = s.emoji;
    el.setAttribute('aria-label', `Stiker ${stickerName(s)}. Geser atau pakai tombol panah untuk memindahkan.`);
    placeSticker(el, s);
    el.addEventListener('pointerdown', event => {
      event.preventDefault();
      selectSticker(i);
      selectReviewTab('sticker');
      el.setPointerCapture(event.pointerId);
      const rect = $('#sticker-layer').getBoundingClientRect();
      const move = ev => {
        s.x = clamp((ev.clientX - rect.left) / rect.width);
        s.y = clamp((ev.clientY - rect.top) / rect.height);
        placeSticker(el, s);
      };
      const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
    el.addEventListener('keydown', event => {
      const step = { ArrowLeft: [-.01, 0], ArrowRight: [.01, 0], ArrowUp: [0, -.01], ArrowDown: [0, .01] }[event.key];
      if (step) { event.preventDefault(); s.x = clamp(s.x + step[0]); s.y = clamp(s.y + step[1]); placeSticker(el, s); }
      if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); selectSticker(i); deleteSticker(); }
    });
    el.addEventListener('focus', () => selectSticker(i));
    return el;
  }));
  selectSticker(state.selectedSticker < state.stickers.length ? state.selectedSticker : -1);
  $('#sticker-count').textContent = state.stickers.length;
  $('#sticker-count').hidden = !state.stickers.length;
}
function editSticker(change) {
  const s = state.stickers[state.selectedSticker];
  if (!s) return;
  change(s);
  placeSticker($$('#sticker-layer .sticker')[state.selectedSticker], s);
}
function deleteSticker() {
  if (state.selectedSticker < 0) return;
  state.stickers.splice(state.selectedSticker, 1);
  state.selectedSticker = -1;
  renderStickers();
}
function renderStickerPicker() {
  const button = (art, label, content) => {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'emoji-btn' });
    b.setAttribute('aria-label', `Tempel stiker ${label}`);
    b.append(content);
    b.addEventListener('click', () => addSticker(art));
    return b;
  };
  $('#sticker-grid').replaceChildren(...state.stickerSources.map(src =>
    button({ src }, stickerName({ src }), Object.assign(new Image(), { src, alt: '', loading: 'lazy', draggable: false }))));
  $('#sticker-grid').hidden = !state.stickerSources.length;
  $('#emoji-grid').replaceChildren(...EMOJIS.map(emoji => button({ emoji }, emoji, emoji)));
}
function applyRetentionText() {
  // Privacy copy follows the server's RETENTION_DAYS (0 = kept permanently for the organisers).
  const days = window.RETENTION_DAYS ?? 7;
  const text = days > 0 ? {
    consent: `Saya setuju foto dan data kontak disimpan sementara, maksimal ${days} hari, untuk keperluan unduh. Siapa pun yang memegang link hasil foto dapat membukanya.`,
    size: `JPG 2160 × 3840 px, maksimal 20 MB, disimpan ${days} hari.`,
    qr: `Buka kamera HP, arahkan ke QR, lalu ketuk link yang muncul. Foto HD bisa diunduh selama ${days} hari.`,
  } : {
    consent: 'Saya setuju foto dan data kontak (nama, program studi, WhatsApp) disimpan oleh panitia Labkom sebagai dokumentasi acara. Siapa pun yang memegang link hasil foto dapat membukanya.',
    size: 'JPG 2160 × 3840 px, maksimal 20 MB, link tidak kedaluwarsa.',
    qr: 'Buka kamera HP, arahkan ke QR, lalu ketuk link yang muncul. Foto HD bisa diunduh kapan saja.',
  };
  $$('[data-retention]').forEach(el => { el.textContent = text[el.dataset.retention]; });
}
function resetEdits() {
  state.filters = Array(shotCount()).fill('normal');
  state.filterTarget = -1;
  state.liveFilter = 'normal';
  state.liveOverlay = 'none';
  state.overlays = Array(shotCount()).fill('none');
  state.layers = Array(shotCount()).fill(null);
  fxCache.length = 0;
  state.stickers = [];
  state.selectedSticker = -1;
}

/* ---------- Save & upload ---------- */
function canvasJpeg(canvas, quality) {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Gagal membuat foto akhir.')), 'image/jpeg', quality));
}
async function finalBlob(canvas) {
  for (const quality of [.95, .92, .88, .84, .78, .7]) {
    const blob = await canvasJpeg(canvas, quality);
    if (blob.size <= MAX_OUTPUT_SIZE) return blob;
  }
  throw new Error('Ukuran foto masih melebihi 20 MB.');
}
function setUploadStage(stage, message) {
  const order = ['render', 'upload', 'finish'];
  const index = order.indexOf(stage);
  $('#upload-overlay').hidden = false;
  $$('#upload-steps li').forEach((li, i) => {
    if (stage === 'error') { if (li.dataset.state === 'active') li.dataset.state = 'failed'; }
    else li.dataset.state = i < index ? 'done' : i === index ? 'active' : 'pending';
  });
  $('#upload-title').textContent = stage === 'error' ? 'Foto belum tersimpan' : 'Menyimpan fotomu…';
  $('#upload-error').hidden = stage !== 'error';
  if (message) $('#upload-error-text').textContent = message;
  if (stage === 'error') $('#upload-retry').focus();
}
async function confirmResult() {
  if (!allPhotosReady() || !state.profile || !state.template || state.uploading) return;
  state.uploading = true;
  const button = $('#confirm-button');
  button.disabled = true;
  setUploadStage('render');
  try {
    await nextFrame(); // let the overlay paint before the heavy 2160×3840 render
    const composite = await renderPoster(FINAL_SIZE.width, FINAL_SIZE.height);
    const blob = await finalBlob(composite);
    setUploadStage('upload');
    const form = new FormData();
    form.append('name', state.profile.name);
    form.append('program', state.profile.program);
    form.append('whatsapp', state.profile.whatsapp);
    form.append('template_id', state.template.id);
    form.append('consent', 'true');
    form.append('image', blob, 'photobooth.jpg');
    let response;
    try { response = await fetch(`${BASE}/api/results`, { method: 'POST', body: form }); }
    catch { throw new Error('Tidak bisa terhubung ke server photobooth. Periksa jaringan, lalu coba simpan lagi.'); }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : `Server menolak foto (kode ${response.status}). Coba simpan lagi.`);
    setUploadStage('finish');
    state.result = data;
    clearInterval(state.interval);
    stopCamera();
    $('#result-image').src = data.imageUrl;
    $('#qr-image').src = data.qrUrl;
    $('#download-link').href = data.imageUrl;
    $('#wa-link').href = data.waUrl;
    $('#qr-network-note').hidden = !/localhost|127\.0\.0\.1|0\.0\.0\.0/.test(data.resultUrl);
    await Promise.race([
      Promise.all([$('#result-image').decode(), $('#qr-image').decode()]).catch(() => {}),
      sleep(8000),
    ]);
    $('#upload-overlay').hidden = true;
    showStep('result');
  } catch (e) {
    setUploadStage('error', e.message || 'Terjadi kesalahan saat memproses foto.');
  } finally {
    state.uploading = false;
    button.disabled = false;
  }
}

/* ---------- Result idle reset ---------- */
function startIdle() {
  state.idleEndsAt = Date.now() + RESULT_IDLE_SECONDS * 1000;
  clearInterval(state.idleTimer);
  state.idleTimer = setInterval(idleTick, 1000);
  idleTick();
}
function stopIdle() { clearInterval(state.idleTimer); state.idleTimer = null; }
function idleTick() {
  const left = Math.ceil((state.idleEndsAt - Date.now()) / 1000);
  if (left <= 0) { resetAll(); return; }
  $('#idle-note').textContent = `Layar kembali ke awal dalam ${left} detik.`;
}
function bumpIdle() { if (state.step === 'result') state.idleEndsAt = Date.now() + RESULT_IDLE_SECONDS * 1000; }

function resetAll() {
  countdownAbort = true;
  stopCamera();clearInterval(state.interval);
  state.profile = null; state.template = null; state.templateImage = null; state.artPromise = null;
  state.photos = Array(shotCount()).fill(null); state.endsAt = 0; state.result = null;
  resetEdits();
  $('#registration-form').reset();
  $$('.field input').forEach(input => setFieldError(input, ''));
  $('#template-next').disabled = true;
  $$('.template-card').forEach(card => card.setAttribute('aria-pressed', 'false'));
  $('#result-image').removeAttribute('src');
  $('#qr-image').removeAttribute('src');
  $('#upload-overlay').hidden = true;
  showStep('register');
}

/* ---------- Registration ---------- */
function setFieldError(input, message) {
  input.setAttribute('aria-invalid', message ? 'true' : 'false');
  const error = $(`#${input.id}-error`);
  if (!error) return;
  error.textContent = message;
  error.hidden = !message;
}
function validateRegistration() {
  const name = $('#field-name').value.trim().replace(/\s+/g,' ');
  const program = $('#field-program').value.trim().replace(/\s+/g,' ');
  const whatsapp = $('#field-phone').value.trim();
  const digits = whatsapp.replace(/[^0-9]/g, '');
  const checks = [
    [$('#field-name'), name.length >= 2 ? '' : 'Tulis nama minimal 2 huruf.'],
    [$('#field-program'), program.length >= 2 ? '' : 'Tulis program studi minimal 2 huruf.'],
    [$('#field-phone'), /^(08\d{8,12}|628\d{8,12})$/.test(digits) ? '' : 'Gunakan nomor WhatsApp Indonesia, contoh 0812 3456 7890.'],
    [$('#field-consent'), $('#field-consent').checked ? '' : 'Centang persetujuan agar fotomu bisa disimpan sementara.'],
  ];
  checks.forEach(([input, message]) => setFieldError(input, message));
  const firstInvalid = checks.find(([, message]) => message);
  if (firstInvalid) { firstInvalid[0].focus(); return null; }
  return { name, program, whatsapp };
}

function setupEvents() {
  $('#registration-form').addEventListener('submit', event => {
    event.preventDefault();
    const profile = validateRegistration();
    if (!profile) return;
    state.profile = profile;
    showStep('template');
  });
  $$('.field input').forEach(input => input.addEventListener(input.type === 'checkbox' ? 'change' : 'input', () => {
    if (input.getAttribute('aria-invalid') === 'true') setFieldError(input, '');
  }));
  $('#template-next').addEventListener('click', async () => {
    if (!state.template) return;
    await createNewSession();
  });
  $$('[data-back]').forEach(b => b.addEventListener('click', () => showStep(b.dataset.back)));
  $('#mirror-camera').addEventListener('change', e => $$('#camera-video, #live-effect, #effect-grid').forEach(el => el.classList.toggle('not-mirrored', !e.target.checked)));
  $('#effect-grid-close').addEventListener('click', closeEffectGrid);
  $('#capture-button').addEventListener('click', countdownAndShoot);
  $('#review-button').addEventListener('click', showReview);
  $('#restart-button').addEventListener('click', createNewSession);
  $('#camera-retry').addEventListener('click', retryCamera);
  $('#camera-back').addEventListener('click', changeFrame);
  $('#change-frame').addEventListener('click', changeFrame);
  $('#confirm-button').addEventListener('click', confirmResult);
  $$('.review-tab').forEach(tab => tab.addEventListener('click', () => selectReviewTab(tab.dataset.tab)));
  renderStickerPicker();
  applyRetentionText();
  $('#sticker-smaller').addEventListener('click', () => editSticker(s => s.size = clamp(s.size * .8, .06, .5)));
  $('#sticker-bigger').addEventListener('click', () => editSticker(s => s.size = clamp(s.size * 1.25, .06, .5)));
  $('#sticker-rotl').addEventListener('click', () => editSticker(s => s.rot = (s.rot - 15) % 360));
  $('#sticker-rotr').addEventListener('click', () => editSticker(s => s.rot = (s.rot + 15) % 360));
  $('#sticker-delete').addEventListener('click', deleteSticker);
  $('#sticker-x').addEventListener('click', deleteSticker);
  try { $('#sound-toggle').checked = localStorage.getItem('photobooth-sound') !== 'off'; } catch {}
  $('#sound-toggle').addEventListener('change', e => {
    try { localStorage.setItem('photobooth-sound', e.target.checked ? 'on' : 'off'); } catch {}
    if (e.target.checked) { unlockAudio(); beep(false); }
  });
  $('#upload-retry').addEventListener('click', confirmResult);
  $('#upload-cancel').addEventListener('click', () => { $('#upload-overlay').hidden = true; });
  $('#copy-link').addEventListener('click', async () => {
    if (!state.result) return;
    try { await navigator.clipboard.writeText(state.result.resultUrl); toast('Link foto disalin.', 'success'); }
    catch { toast('Tidak dapat menyalin otomatis. Gunakan link dari QR atau WhatsApp.', 'error'); }
  });
  $('#new-session').addEventListener('click', resetAll);
  // Space / Enter fires the shutter, so an operator can use a keyboard or presenter clicker.
  document.addEventListener('keydown', event => {
    if (state.step !== 'camera' || event.repeat || (event.key !== ' ' && event.key !== 'Enter')) return;
    if (event.target.closest('button, input, a')) return;
    event.preventDefault();
    if (!$('#capture-button').disabled) countdownAndShoot();
  });
  document.addEventListener('pointerdown', bumpIdle, { passive: true });
  document.addEventListener('keydown', bumpIdle);
  window.addEventListener('beforeunload', stopCamera);
}
(async function init() {
  setupEvents();
  apiGet(`${BASE}/api/stickers`).then(list => { state.stickerSources = list; renderStickerPicker(); }).catch(() => {}); // emoji still work without it
  try { await loadTemplates(); }
  catch (e) { toast('Gagal memuat template. Jalankan server dan coba refresh.', 'error'); }
})();
