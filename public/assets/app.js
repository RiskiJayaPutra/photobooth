/* Labkom Photobooth — vanilla JS, no third-party frontend dependencies. */
'use strict';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));
const MAX_OUTPUT_SIZE = 20 * 1024 * 1024;
const SESSION_SECONDS = 120;
const SHOT_COUNTDOWN = 5;
const FINAL_SIZE = { width: 2160, height: 3840 };
const RESULT_IDLE_SECONDS = 120; // result screen returns to start so the next visitor never sees the previous photo
const SLOT_NAMES = ['atas', 'tengah', 'bawah'];

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
};
let toastTimer;
let countdownAbort = false;

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
function icon(id) { return `<svg class="ico" aria-hidden="true"><use href="#${id}"/></svg>`; }

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
    state.templates = await apiGet('/api/templates');
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
    toast(allPhotosReady() ? 'Waktu sesi habis. Kamu masih bisa melanjutkan ke hasil.' : 'Waktu 2 menit habis. Tekan Ulang sesi untuk mengambil 3 foto lagi.', 'error');
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
  for (let i = 0; i < 3; i++) {
    const shot = document.createElement('div');
    shot.className = 'shot-slot';
    shot.classList.toggle('next', i === state.currentShot && !sessionExpired());
    const tag = document.createElement('span'); tag.className = 'tag';
    if (state.photos[i]) {
      const img = document.createElement('img'); img.alt = `Foto ${i + 1}`; img.src = state.photos[i]; shot.append(img);
      tag.textContent = `${i + 1}`;
      shot.append(tag);
    } else shot.textContent = i + 1;
    container.append(shot);
  }
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
  const imgs = await Promise.all(state.photos.map(p => p ? loadImage(p) : null));
  if (token !== state.liveDraw) return;
  const ctx = canvas.getContext('2d');
  const sx = canvas.width / t.artWidth, sy = canvas.height / t.artHeight;
  ctx.fillStyle = '#DCE2F5'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  t.slots.forEach((s, i) => {
    const box = { x: s.x * sx, y: s.y * sy, w: s.w * sx, h: s.h * sy, r: 0 };
    if (imgs[i]) drawImageCover(ctx, imgs[i], box);
    else {
      ctx.fillStyle = '#97A3CF'; ctx.font = `800 ${Math.round(box.h * .4)}px "Bricolage Grotesque", sans-serif`;
      ctx.fillText(String(i + 1), box.x + box.w / 2, box.y + box.h / 2);
    }
  });
  ctx.drawImage(art, 0, 0, canvas.width, canvas.height);
}
function updateCaptureHeading() {
  const number = state.currentShot + 1;
  const expired = sessionExpired();
  $('#capture-title').textContent = state.retaking ? `Ulangi foto ${number}` : `Foto ${number} dari 3`;
  $('#capture-label').textContent = expired ? 'Waktu habis' : state.retaking ? `Ulangi foto ${number}` : `Ambil foto ${number}`;
  $('#hud-shot').textContent = `Foto ${number}, jendela ${SLOT_NAMES[state.currentShot]}`;
  $('#capture-button').disabled = expired || state.countingDown || timeRemaining() < 6 || !state.videoStream;
  const reviewButton = $('#review-button');
  reviewButton.hidden = !(allPhotosReady() && !state.countingDown);
  reviewButton.querySelector('span').textContent = state.retaking && !expired ? 'Batal ulangi' : 'Lihat hasil';
  $('#restart-button').hidden = !(expired && !allPhotosReady());
  $('#change-frame').hidden = state.countingDown;
  let status = 'Posisikan wajah di area terang, lalu tekan Ambil foto.';
  if (state.countingDown) status = 'Tahan pose… kamera memotret saat hitungan habis.';
  else if (expired) status = allPhotosReady() ? 'Waktu habis. Lanjutkan ke hasil untuk menyimpan foto.' : 'Waktu habis sebelum 3 foto selesai. Tekan Ulang sesi untuk mencoba lagi.';
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
  state.photos = [null, null, null];
  state.currentShot = 0;
  state.retaking = false;
  state.countingDown = false;
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
function restartAnimation(element, className) {
  element.classList.remove(className); void element.offsetWidth; element.classList.add(className);
}
async function countdownAndShoot() {
  if (state.countingDown || timeRemaining() < SHOT_COUNTDOWN + .6 || !state.videoStream) {
    toast('Waktu tidak cukup atau kamera belum siap.', 'error'); return;
  }
  state.countingDown = true;
  countdownAbort = false;
  updateCaptureHeading();
  const display = $('#countdown');
  try {
    for (let sec = SHOT_COUNTDOWN; sec > 0; sec--) {
      if (countdownAbort || timeRemaining() <= 0) throw new Error('Countdown dibatalkan.');
      display.hidden = false;
      $('#countdown-num').textContent = sec;
      restartAnimation(display, 'tick');
      await sleep(1000);
    }
    if (countdownAbort || timeRemaining() <= 0) throw new Error('Waktu sesi sudah habis.');
    display.hidden = true;
    const shot = state.currentShot;
    state.photos[shot] = captureVideoFrame();
    restartAnimation($('#flash'), 'go');
    await sleep(450);
    if (state.retaking || allPhotosReady()) {
      state.retaking = false;
      await showReview();
    } else {
      state.currentShot = state.photos.findIndex(photo => !photo);
      toast(`Foto ${shot + 1} tersimpan. Siap untuk foto ${state.currentShot + 1}.`, 'success');
    }
  } catch(e) { toast(e.message, 'error'); }
  finally {
    display.hidden = true;
    state.countingDown = false;
    if (state.step === 'camera') updateCaptureHeading();
  }
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
  state.photos = [null, null, null];
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
  for (let i = 0; i < 3; i++) {
    const item = document.createElement('div'); item.className = 'review-shot';
    const img = document.createElement('img'); img.src = state.photos[i]; img.alt = `Foto ${i + 1}`;
    const details = document.createElement('div');
    const b = document.createElement('b'); b.textContent = `Foto ${i + 1}`;
    const where = document.createElement('span'); where.textContent = `Jendela ${SLOT_NAMES[i]}`;
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
      showStep('camera'); updateCaptureHeading();
    });
    const mark = (on) => $(`#review-marks [data-slot="${i}"]`)?.classList.toggle('hover', on);
    item.addEventListener('pointerenter', () => mark(true));
    item.addEventListener('pointerleave', () => mark(false));
    item.addEventListener('focusin', () => mark(true));
    item.addEventListener('focusout', () => mark(false));
    item.append(img, details, button);
    reviewList.append(item);
  }
  $('#review-expired').hidden = canRetake;
  const canvas = $('#preview-canvas');
  canvas.width = 720;
  canvas.height = Math.round(720 * template.artHeight / template.artWidth);
  const composite = await renderPoster(canvas.width, canvas.height);
  canvas.getContext('2d').drawImage(composite, 0, 0);
  onTimerTick();
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
    try { response = await fetch('/api/results', { method: 'POST', body: form }); }
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
  state.photos = [null, null, null]; state.endsAt = 0; state.result = null;
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
  $('#mirror-camera').addEventListener('change', e => $('#camera-video').classList.toggle('not-mirrored', !e.target.checked));
  $('#capture-button').addEventListener('click', countdownAndShoot);
  $('#review-button').addEventListener('click', showReview);
  $('#restart-button').addEventListener('click', createNewSession);
  $('#camera-retry').addEventListener('click', retryCamera);
  $('#camera-back').addEventListener('click', changeFrame);
  $('#change-frame').addEventListener('click', changeFrame);
  $('#confirm-button').addEventListener('click', confirmResult);
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
  try { await loadTemplates(); }
  catch (e) { toast('Gagal memuat template. Jalankan server dan coba refresh.', 'error'); }
})();
