// Admin panel: login, then a searchable grid of every participant and their photo.
const BASE = window.BASE_PATH || '';
const $ = selector => document.querySelector(selector);
let entries = [];
let searchTimer = 0;

function show(view) {
  $('#login-view').hidden = view !== 'login';
  $('#dash-view').hidden = view !== 'dash';
  $('#logout').hidden = view !== 'dash';
  if (view === 'login') $('#login-user').focus();
}

async function load() {
  const params = new URLSearchParams({
    q: $('#search').value, program: $('#filter-program').value, template: $('#filter-template').value,
  });
  const response = await fetch(`${BASE}/admin/api/entries?${params}`, { cache: 'no-store' });
  if (response.status === 401) { show('login'); return; }
  if (!response.ok) throw new Error('Gagal memuat data.');
  const data = await response.json();
  fillSelect($('#filter-program'), data.programs.map(p => [p, p]));
  fillSelect($('#filter-template'), data.templates.map(t => [t.id, t.title]));
  entries = data.entries;
  const filtered = $('#search').value || $('#filter-program').value || $('#filter-template').value;
  $('#summary').innerHTML = filtered
    ? `<b>${entries.length}</b> dari ${data.total} peserta cocok`
    : `<b>${data.total}</b> peserta sudah berfoto`;
  render();
  show('dash');
}

function fillSelect(select, options) {
  // Keep the first "Semua …" option and the current choice while refreshing the list.
  const current = select.value;
  select.replaceChildren(select.options[0], ...options.map(([value, label]) => new Option(label, value)));
  select.value = options.some(([value]) => value === current) ? current : '';
}

function render() {
  $('#empty').hidden = entries.length > 0;
  $('#entries').replaceChildren(...entries.map((entry, i) => {
    const card = Object.assign(document.createElement('button'), { type: 'button', className: 'entry' });
    const img = Object.assign(new Image(), { src: entry.thumbUrl, alt: '', loading: 'lazy', decoding: 'async' });
    const name = document.createElement('b'); name.textContent = entry.name;
    const meta = document.createElement('span'); meta.className = 'meta';
    for (const text of [entry.program, entry.template, entry.createdText]) {
      const line = document.createElement('span'); line.textContent = text; meta.append(line);
    }
    card.append(img, name, meta);
    card.addEventListener('click', () => openViewer(i));
    return card;
  }));
}

function phoneText(wa) { return wa.startsWith('62') ? `0${wa.slice(2)}` : wa; }
function sizeText(bytes) { return `${(bytes / 1024 / 1024).toFixed(1)} MB`; }

function openViewer(i) {
  const entry = entries[i];
  $('#viewer-img').src = entry.photoUrl;
  $('#viewer-img').alt = `Foto ${entry.name}`;
  $('#viewer-name').textContent = entry.name;
  $('#viewer-program').textContent = entry.program;
  $('#viewer-wa').textContent = phoneText(entry.whatsapp);
  $('#viewer-wa').href = `https://wa.me/${entry.whatsapp}`;
  $('#viewer-template').textContent = entry.template;
  $('#viewer-time').textContent = entry.createdText;
  $('#viewer-size').textContent = sizeText(entry.sizeBytes);
  $('#viewer-download').href = `${entry.photoUrl}?dl=1`;
  $('#viewer-link').href = entry.resultUrl;
  $('#viewer').hidden = false;
  $('#viewer-close').focus();
}
function closeViewer() { $('#viewer').hidden = true; $('#viewer-img').removeAttribute('src'); }

$('#login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  $('#login-error').hidden = true;
  try {
    const response = await fetch(`${BASE}/admin/login`, { method: 'POST', body: new FormData(event.target) });
    if (!response.ok) {
      const detail = (await response.json().catch(() => ({}))).detail;
      throw new Error(detail || 'Gagal masuk.');
    }
    $('#login-pass').value = '';
    await load();
  } catch (error) {
    $('#login-error').textContent = error.message;
    $('#login-error').hidden = false;
  } finally {
    button.disabled = false;
  }
});
$('#logout').addEventListener('click', async () => {
  await fetch(`${BASE}/admin/logout`, { method: 'POST' });
  entries = [];
  $('#entries').replaceChildren();
  show('login');
});
$('#search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(load, 250); });
$('#filter-program').addEventListener('change', load);
$('#filter-template').addEventListener('change', load);
$('#viewer-close').addEventListener('click', closeViewer);
$('#viewer').addEventListener('click', event => { if (event.target.id === 'viewer') closeViewer(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('#viewer').hidden) closeViewer(); });

load().catch(() => show('login'));
