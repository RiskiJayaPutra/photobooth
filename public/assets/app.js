/* Labkom Photobooth — vanilla JS, no third-party frontend dependencies. */
'use strict';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));
const MAX_OUTPUT_SIZE = 20 * 1024 * 1024;
const SESSION_SECONDS = 120;
const SHOT_COUNTDOWN = 5;
const FINAL_SIZE = { width: 2160, height: 3840 };

const state = {
  profile: null,
  templates: [],
  template: null,
  templateImage: null,
  photos: [null, null, null],
  videoStream: null,
  endsAt: 0,
  interval: null,
  currentShot: 0,
  retaking: false,
  countingDown: false,
  step: 'register',
  result: null,
};
let toastTimer;
let countdownAbort = false;

function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.hidden = true, 4800);
}
function humanTime(seconds) {
  const s = Math.max(0, Math.ceil(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
function timeRemaining() { return Math.max(0, (state.endsAt - Date.now()) / 1000); }
function allPhotosReady() { return state.photos.every(Boolean); }
function showStep(name) {
  state.step = name;
  for (const pane of ['register','template','camera','review','result']) {
    $(`#pane-${pane}`).hidden = pane !== name;
  }
  const order = ['register','template','camera','result'];
  const current = order.indexOf(name === 'review' ? 'camera' : name);
  $$('.step').forEach((element, i) => {
    element.classList.toggle('active', i === current);
    element.classList.toggle('done', i < current);
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
async function apiGet(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Kesalahan server (${response.status})`);
  return await response.json();
}
async function loadTemplates() {
  state.templates = await apiGet('/api/templates');
  const container = $('#template-grid');
  container.replaceChildren();
  for (const template of state.templates) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'template-card';
    card.dataset.template = template.id;
    card.innerHTML = `<span class="check">✓</span><img alt="" loading="lazy"/><span class="name"></span><span class="desc"></span>`;
    card.querySelector('img').src = template.preview;
    card.querySelector('.name').textContent = template.title;
    card.querySelector('.desc').textContent = template.desc;
    card.addEventListener('click', () => {
      state.template = template;
      $$('.template-card').forEach(node => node.classList.toggle('selected', node.dataset.template === template.id));
      $('#template-next').disabled = false;
    });
    container.append(card);
  }
}
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Gagal memuat template.'));
    img.src = src;
  });
}
function stopCamera() {
  if (state.videoStream) {
    for (const track of state.videoStream.getTracks()) track.stop();
    state.videoStream = null;
  }
  $('#camera-video').srcObject = null;
}
async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Browser tidak mendukung kamera. Jalankan melalui localhost atau HTTPS.');
  }
  stopCamera();
  const constraints = {
    audio: false,
    video: { facingMode: 'user', width: { ideal: 1920 }, height: { ideal: 1440 }, aspectRatio: { ideal: 4 / 3 } },
  };
  try {
    state.videoStream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (e) {
    if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
      throw new Error('Akses kamera ditolak. Izinkan kamera di pengaturan browser lalu coba lagi.');
    }
    if (e.name === 'NotFoundError') throw new Error('Kamera tidak ditemukan pada perangkat ini.');
    throw new Error('Tidak dapat membuka kamera: ' + e.message);
  }
  const video = $('#camera-video');
  video.srcObject = state.videoStream;
  await video.play();
  $('#camera-message').hidden = true;
  $('#capture-button').disabled = false;
  $('#camera-status').textContent = 'Kamera siap • Posisikan wajah di dalam frame';
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
  $('#session-timer strong').textContent = humanTime(remaining);
  $('#review-time').textContent = humanTime(remaining);
  $('#session-timer').classList.toggle('urgent', remaining <= 20);
  if (remaining > 0) return;
  clearInterval(state.interval);
  countdownAbort = true;
  if (state.step === 'camera') {
    $('#capture-button').disabled = true;
    $('#capture-button').textContent = 'Waktu Habis';
    $('#countdown').hidden = true;
    if (allPhotosReady()) {
      $('#review-button').hidden = false;
      toast('Waktu sesi habis. Kamu masih bisa melanjutkan konfirmasi.');
    } else {
      $('#restart-button').hidden = false;
      toast('Waktu 2 menit habis. Mulai ulang sesi untuk mengambil 3 foto.');
    }
  }
  if (state.step === 'review') {
    $$('.retake').forEach(button => button.disabled = true);
    toast('Waktu retake habis, tetapi kamu tetap bisa mengonfirmasi hasil foto.');
  }
}
function renderCameraSlots() {
  const container = $('#shot-slots');
  container.replaceChildren();
  for (let i = 0; i < 3; i++) {
    const shot = document.createElement('div');
    shot.className = 'shot-slot';
    const thumb = document.createElement('div');
    thumb.className = 'shot-thumb';
    if (state.photos[i]) {
      const img = document.createElement('img'); img.alt = `Foto ${i + 1}`; img.src = state.photos[i]; thumb.append(img);
    } else thumb.textContent = i + 1;
    const detail = document.createElement('div');
    detail.className = 'shot-detail';
    const title = document.createElement('b'); title.textContent = `Foto ${i + 1}`;
    const desc = document.createElement('small'); desc.textContent = state.photos[i] ? '✓ Tersimpan' : i === state.currentShot ? '● Selanjutnya' : 'Belum diambil';
    detail.append(title, desc); shot.append(thumb, detail);container.append(shot);
  }
  $('#capture-count').textContent = `${state.photos.filter(Boolean).length}/3`;
}
function updateCaptureHeading() {
  const number = state.currentShot + 1;
  $('#capture-title').textContent = state.retaking ? `Foto Ulang ${number} dari 3` : `Foto ${number} dari 3`;
  $('#capture-button').textContent = state.retaking ? `◉ Mulai Ulang Foto ${number}` : `◉ Mulai Foto ${number}`;
  $('#capture-button').disabled = timeRemaining() < 6 || !state.videoStream;
  $('#review-button').hidden = !(allPhotosReady() && !state.countingDown);
  renderCameraSlots();
}
async function createNewSession() {
  countdownAbort = true;
  clearInterval(state.interval);
  state.photos = [null, null, null];
  state.currentShot = 0;
  state.retaking = false;
  state.countingDown = false;
  $('#restart-button').hidden = true;
  $('#review-button').hidden = true;
  $('#camera-message').hidden = false;
  $('#camera-message').textContent = 'Mengaktifkan kamera...';
  state.templateImage = await loadImage(state.template.asset);
  showStep('camera');
  await startCamera();
  startSessionClock();
  updateCaptureHeading();
}
function captureVideoFrame() {
  const video = $('#camera-video');
  if (video.readyState < 2 || !video.videoWidth) throw new Error('Video kamera belum siap.');
  const c = document.createElement('canvas');
  c.width = 1600; c.height = 1200; // 4:3 per shot
  const ctx = c.getContext('2d', { alpha: false });
  const vw = video.videoWidth, vh = video.videoHeight;
  const sourceRatio = vw / vh;
  const wanted = 4 / 3;
  let sw = vw, sh = vh, sx = 0, sy = 0;
  if (sourceRatio > wanted) { sw = vh * wanted; sx = (vw - sw) / 2; }
  else { sh = vw / wanted; sy = (vh - sh) / 2; }
  if ($('#mirror-camera').checked) { ctx.translate(c.width, 0);ctx.scale(-1, 1); }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', .95);
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function countdownAndShoot() {
  if (state.countingDown || timeRemaining() < SHOT_COUNTDOWN + .6 || !state.videoStream) {
    toast('Waktu tidak cukup atau kamera belum siap.'); return;
  }
  state.countingDown = true;
  countdownAbort = false;
  $('#capture-button').disabled = true;
  const display = $('#countdown');
  display.hidden = false;
  try {
    for (let sec = SHOT_COUNTDOWN; sec > 0; sec--) {
      if (countdownAbort || timeRemaining() <= 0) throw new Error('Countdown dibatalkan.');
      display.textContent = sec;
      await sleep(1000);
    }
    if (countdownAbort || timeRemaining() <= 0) throw new Error('Waktu sesi sudah habis.');
    display.textContent = '📸';
    state.photos[state.currentShot] = captureVideoFrame();
    await sleep(300);
    if (state.retaking || allPhotosReady()) {
      state.retaking = false;
      await showReview();
    } else {
      state.currentShot = state.photos.findIndex(photo => !photo);
      updateCaptureHeading();
      toast(`Foto tersimpan! Siap untuk foto ${state.currentShot + 1}.`);
    }
  } catch(e) { toast(e.message); }
  finally {
    display.hidden = true;
    state.countingDown = false;
    if (state.step === 'camera') updateCaptureHeading();
  }
}
function drawImageCover(ctx, img, box) {
  const { x, y, w, h, r } = box;
  const frameAspect = w / h;
  const sourceAspect = img.naturalWidth / img.naturalHeight;
  let sx = 0, sy = 0, sw = img.naturalWidth, sh = img.naturalHeight;
  if (sourceAspect > frameAspect) { sw = img.naturalHeight * frameAspect; sx = (img.naturalWidth - sw) / 2; }
  else { sh = img.naturalWidth / frameAspect; sy = (img.naturalHeight - sh) / 2; }
  ctx.save();ctx.beginPath();
  if (r && typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
  ctx.restore();
}
async function renderPoster(width, height) {
  if (!allPhotosReady()) throw new Error('Ketiga foto harus diambil terlebih dahulu.');
  const template = state.template;
  const art = state.templateImage || await loadImage(template.asset);
  const imgs = await Promise.all(state.photos.map(photo => loadImage(photo)));
  const canvas = document.createElement('canvas');
  canvas.width = width;canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false });
  const sx = width / template.artWidth, sy = height / template.artHeight;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = true;ctx.imageSmoothingQuality = 'high';
  template.slots.forEach((slot, index) => {
    drawImageCover(ctx, imgs[index], {
      x: slot.x * sx, y: slot.y * sy,
      w: slot.w * sx, h: slot.h * sy, r: slot.r * (sx + sy) / 2,
    });
  });
  ctx.drawImage(art, 0, 0, width, height);
  return canvas;
}
async function showReview() {
  if (!allPhotosReady()) return;
  showStep('review');
  const reviewList = $('#review-shots');
  reviewList.replaceChildren();
  for (let i = 0; i < 3; i++) {
    const item = document.createElement('div'); item.className = 'review-shot';
    const img = document.createElement('img'); img.src = state.photos[i];img.alt = `Foto ${i + 1}`;
    const details = document.createElement('div');details.className = 'details';
    const b = document.createElement('b');b.textContent = `Foto ${i + 1}`;
    const status = document.createElement('span');status.textContent = '✓ Siap digunakan';
    details.append(b,status);
    const button = document.createElement('button');button.className = 'retake';button.textContent = '↻ Retake';
    button.disabled = timeRemaining() < 6;
    button.addEventListener('click', async () => {
      if (timeRemaining() < 6) {toast('Waktu retake tidak mencukupi.');return;}
      state.currentShot = i;state.retaking = true;
      showStep('camera');updateCaptureHeading();
    });
    item.append(img, details, button);
    reviewList.append(item);
  }
  const canvas = $('#preview-canvas');
  const composite = await renderPoster(canvas.width, canvas.height);
  canvas.getContext('2d').drawImage(composite, 0, 0);
  onTimerTick();
}
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
async function confirmResult() {
  if (!allPhotosReady() || !state.profile || !state.template) return;
  const button = $('#confirm-button');
  button.disabled = true;button.textContent = '⏳ Memproses foto HD...';
  try {
    const composite = await renderPoster(FINAL_SIZE.width, FINAL_SIZE.height);
    const blob = await finalBlob(composite);
    const form = new FormData();
    form.append('name', state.profile.name);
    form.append('program', state.profile.program);
    form.append('whatsapp', state.profile.whatsapp);
    form.append('template_id', state.template.id);
    form.append('consent', 'true');
    form.append('image', blob, 'photobooth.jpg');
    const response = await fetch('/api/results', { method: 'POST', body: form });
    const data = await response.json();
    if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Gagal memproses hasil foto.');
    state.result = data;
    clearInterval(state.interval);
    stopCamera();
    $('#result-image').src = data.imageUrl;
    $('#qr-image').src = data.qrUrl;
    $('#download-link').href = data.imageUrl;
    $('#wa-link').href = data.waUrl;
    $('#qr-network-note').hidden = !/localhost|127\.0\.0\.1|0\.0\.0\.0/.test(data.resultUrl);
    selectShare('qr');
    showStep('result');
    toast('Foto HD berhasil disimpan!');
  } catch (e) {
    toast(e.message || 'Terjadi kesalahan saat memproses foto.');
  } finally {
    button.disabled = false;button.textContent = '✓ Konfirmasi & Proses Foto HD';
  }
}
function selectShare(method) {
  $$('.share-tab').forEach(tab => tab.classList.toggle('selected', tab.dataset.share === method));
  $('#share-qr').hidden = method !== 'qr';
  $('#share-wa').hidden = method !== 'wa';
}
function resetAll() {
  countdownAbort = true;
  stopCamera();clearInterval(state.interval);
  state.profile = null; state.template = null;state.templateImage = null;
  state.photos = [null, null, null];state.endsAt = 0;state.result = null;
  $('#registration-form').reset();
  $('#template-next').disabled = true;
  $$('.template-card').forEach(card => card.classList.remove('selected'));
  showStep('register');
}
function setupEvents() {
  $('#registration-form').addEventListener('submit', event => {
    event.preventDefault();
    const name = $('#field-name').value.trim().replace(/\s+/g,' ');
    const program = $('#field-program').value.trim().replace(/\s+/g,' ');
    const whatsapp = $('#field-phone').value.trim();
    const digits = whatsapp.replace(/[^0-9]/g, '');
    if (!/^(08\d{8,12}|628\d{8,12})$/.test(digits)) {
      toast('Masukkan nomor WhatsApp Indonesia yang valid (08... atau 628...).');return;
    }
    if (!$('#field-consent').checked) { toast('Persetujuan dibutuhkan untuk menyimpan hasil foto sementara.');return; }
    state.profile = { name, program, whatsapp };
    showStep('template');
  });
  $('#template-next').addEventListener('click', async () => {
    if (!state.template) return;
    const button = $('#template-next');button.disabled = true;button.textContent = '⏳ Menyiapkan kamera...';
    try { await createNewSession(); }
    catch(e) { stopCamera();showStep('template');toast(e.message); }
    finally { button.textContent = 'Aktifkan Kamera →';button.disabled = !state.template; }
  });
  $$('[data-back]').forEach(b => b.addEventListener('click', () => showStep(b.dataset.back)));
  $('#mirror-camera').addEventListener('change', e => $('#camera-video').classList.toggle('not-mirrored', !e.target.checked));
  $('#capture-button').addEventListener('click', countdownAndShoot);
  $('#review-button').addEventListener('click', showReview);
  $('#restart-button').addEventListener('click', async () => {
    try { await createNewSession(); } catch (e) {toast(e.message);}
  });
  $('#confirm-button').addEventListener('click', confirmResult);
  $$('.share-tab').forEach(tab => tab.addEventListener('click', () => selectShare(tab.dataset.share)));
  $('#copy-link').addEventListener('click', async () => {
    if (!state.result) return;
    try { await navigator.clipboard.writeText(state.result.resultUrl);toast('Link foto berhasil disalin!'); }
    catch { toast('Tidak dapat menyalin otomatis. Gunakan link dari QR atau WhatsApp.'); }
  });
  $('#new-session').addEventListener('click', resetAll);
  window.addEventListener('beforeunload', stopCamera);
}
(async function init() {
  setupEvents();
  try { await loadTemplates(); }
  catch (e) { toast('Gagal memuat template. Jalankan server dan coba refresh.'); }
})();
