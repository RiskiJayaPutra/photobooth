"""Labkom Photobooth — local FastAPI server.

Run: python -m uvicorn server:app --reload --port 8000
Deploy with PUBLIC_BASE_URL=https://photobooth.example.com.
"""
from __future__ import annotations

import io
import asyncio
from contextlib import asynccontextmanager, closing
import json
import os
import re
import secrets
import sqlite3
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote

import qrcode
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageFilter, ImageOps, UnidentifiedImageError

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / 'public'
DATA = ROOT / 'data'
FILES = DATA / 'results'
DB_PATH = DATA / 'photobooth.db'
FILES.mkdir(parents=True, exist_ok=True)
TEMPLATES = json.loads((PUBLIC / 'assets' / 'templates' / 'config.json').read_text(encoding='utf-8'))
TEMPLATE_IDS = {t['id'] for t in TEMPLATES}
MAX_BYTES = 20 * 1024 * 1024
RETENTION_DAYS = int(os.getenv('RETENTION_DAYS', '7'))
HD_SIZE = (2160, 3840)
PUBLIC_BASE_URL = os.getenv('PUBLIC_BASE_URL', '').rstrip('/')
Image.MAX_IMAGE_PIXELS = 32_000_000


def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


# Participant data lives in SQLite; the HD JPGs stay as files in data/results.
with closing(db()) as _conn, _conn:
    _conn.execute('PRAGMA journal_mode=WAL')
    _conn.execute('''CREATE TABLE IF NOT EXISTS entries (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        program TEXT NOT NULL,
        whatsapp TEXT NOT NULL,
        template_id TEXT NOT NULL,
        created_at REAL NOT NULL,
        expires_at REAL NOT NULL,
        image_bytes INTEGER NOT NULL)''')
    _conn.execute('CREATE INDEX IF NOT EXISTS entries_expires_at ON entries (expires_at)')


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Hapus file dan data kontak yang kedaluwarsa saat server berjalan.
    tidy_old_results()
    async def hourly_cleanup():
        while True:
            await asyncio.sleep(3600)
            await asyncio.to_thread(tidy_old_results)
    worker = asyncio.create_task(hourly_cleanup())
    try:
        yield
    finally:
        worker.cancel()
        try:
            await worker
        except asyncio.CancelledError:
            pass

app = FastAPI(title='Dies Natalis Unila Photobooth', docs_url=None, redoc_url=None, lifespan=lifespan)
app.mount('/assets', StaticFiles(directory=PUBLIC / 'assets'), name='assets')


def valid_wa(value: str) -> str:
    digits = re.sub(r'\D', '', value)
    if digits.startswith('0'):
        digits = '62' + digits[1:]
    if not digits.startswith('628') or len(digits) < 11 or len(digits) > 16:
        raise HTTPException(422, 'Nomor WhatsApp harus menggunakan nomor Indonesia yang valid.')
    return digits


def clean_text(value: str, label: str, limit: int) -> str:
    value = ' '.join(value.strip().split())
    if not 2 <= len(value) <= limit:
        raise HTTPException(422, f'{label} harus terdiri dari 2–{limit} karakter.')
    return value


def delete_entries(keys: list[str]) -> None:
    with closing(db()) as conn, conn:
        conn.executemany('DELETE FROM entries WHERE id = ?', [(key,) for key in keys])
    for key in keys:
        (FILES / f'{key}.jpg').unlink(missing_ok=True)


def get_entry(key: str) -> dict:
    if not re.fullmatch(r'[A-Za-z0-9_-]{12,40}', key):
        raise HTTPException(404, 'Hasil foto tidak ditemukan.')
    with closing(db()) as conn:
        row = conn.execute('SELECT * FROM entries WHERE id = ?', (key,)).fetchone()
    if row is None:
        raise HTTPException(404, 'Hasil foto tidak ditemukan.')
    if row['expires_at'] <= time.time():
        delete_entries([key])
        raise HTTPException(410, 'Masa penyimpanan hasil foto telah berakhir.')
    return dict(row)


def result_url(request: Request, key: str) -> str:
    base = PUBLIC_BASE_URL or str(request.base_url).rstrip('/')
    return f'{base}/r/{key}'


def tidy_old_results() -> None:
    with closing(db()) as conn:
        expired = [row[0] for row in conn.execute('SELECT id FROM entries WHERE expires_at < ?', (time.time(),))]
    delete_entries(expired)


@app.get('/')
def homepage():
    return FileResponse(PUBLIC / 'index.html', headers={'Cache-Control': 'no-cache'})


@app.get('/api/templates')
def get_templates():
    return TEMPLATES


@app.post('/api/results')
async def create_result(
    request: Request,
    name: str = Form(...),
    program: str = Form(...),
    whatsapp: str = Form(...),
    template_id: str = Form(...),
    consent: bool = Form(False),
    image: UploadFile = File(...),
):
    if not consent:
        raise HTTPException(422, 'Persetujuan penyimpanan sementara diperlukan.')
    name = clean_text(name, 'Nama', 80)
    program = clean_text(program, 'Program studi', 80)
    phone = valid_wa(whatsapp)
    if template_id not in TEMPLATE_IDS:
        raise HTTPException(422, 'Template tidak ditemukan.')
    if image.content_type not in ('image/jpeg', 'image/png', 'image/webp'):
        raise HTTPException(415, 'Unggah JPG, PNG, atau WebP.')
    image_bytes = await image.read(MAX_BYTES + 1)
    if len(image_bytes) > MAX_BYTES:
        raise HTTPException(413, 'Ukuran berkas maksimal 20 MB.')

    try:
        original = Image.open(io.BytesIO(image_bytes))
        original.load()
        if original.width * original.height > 28_000_000:
            raise HTTPException(413, 'Resolusi file terlalu besar.')
        picture = ImageOps.exif_transpose(original).convert('RGB')
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise HTTPException(415, 'Berkas gambar tidak valid.') from exc

    # High-quality conventional resampling + restrained sharpening; not AI super-resolution.
    if picture.size != HD_SIZE:
        picture = ImageOps.fit(picture, HD_SIZE, method=Image.Resampling.LANCZOS)
    picture = picture.filter(ImageFilter.UnsharpMask(radius=1.15, percent=115, threshold=3))
    packed = None
    for quality in (94, 91, 87, 83, 78, 72):
        out = io.BytesIO()
        picture.save(out, format='JPEG', quality=quality, subsampling=0, optimize=True, progressive=True)
        if out.tell() <= MAX_BYTES:
            packed = out.getvalue()
            break
    if packed is None:
        raise HTTPException(413, 'Hasil melebihi 20 MB. Kurangi resolusi sumber.')

    tidy_old_results()
    key = secrets.token_urlsafe(16)
    created = time.time()
    expire = created + RETENTION_DAYS * 86400
    (FILES / f'{key}.jpg').write_bytes(packed)
    with closing(db()) as conn, conn:
        conn.execute(
            'INSERT INTO entries (id, name, program, whatsapp, template_id, created_at, expires_at, image_bytes)'
            ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            (key, name, program, phone, template_id, created, expire, len(packed)))
    url = result_url(request, key)
    wa_text = f'Halo! Ini hasil photobooth Dies Natalis Teknik Unila 2026 saya: {url}'
    return {
        'id': key,
        'resultUrl': url,
        'qrUrl': f'/qr/{key}.png',
        'imageUrl': f'/files/{key}.jpg',
        'waUrl': f'https://wa.me/{phone}?text={quote(wa_text)}',
        'expiresAt': datetime.fromtimestamp(expire, timezone.utc).isoformat(),
        'sizeBytes': len(packed),
        'mode': 'manual_whatsapp',
    }


@app.get('/files/{key}.jpg')
def photo_image(key: str):
    get_entry(key)
    return FileResponse(FILES / f'{key}.jpg', media_type='image/jpeg',
                        headers={'Cache-Control': 'private, max-age=3600', 'X-Robots-Tag': 'noindex'})


@app.get('/qr/{key}.png')
def photo_qr(key: str, request: Request):
    get_entry(key)
    qr = qrcode.QRCode(box_size=10, border=3, error_correction=qrcode.constants.ERROR_CORRECT_M)
    qr.add_data(result_url(request, key))
    qr.make(fit=True)
    png = io.BytesIO()
    qr.make_image(fill_color='#14142a', back_color='white').save(png, 'PNG')
    return Response(png.getvalue(), media_type='image/png', headers={'Cache-Control': 'no-store'})


@app.get('/r/{key}')
def public_result(key: str, request: Request):
    entry = get_entry(key)
    # Public view never exposes name, phone, or program.
    # The unguessable URL acts as a private share link until expiry.
    path = f'/files/{key}.jpg'
    expires = datetime.fromtimestamp(entry['expires_at'], timezone(timedelta(hours=7)))  # WIB
    months = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des']
    expires_text = f'{expires.day} {months[expires.month - 1]} {expires.year}, {expires:%H.%M} WIB'
    html = f'''<!doctype html><html lang="id"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="robots" content="noindex,nofollow"/>
<meta name="theme-color" content="#0C1333"/>
<title>Hasil Photobooth — Dies Natalis Teknik Unila 2026</title>
<link rel="icon" type="image/png" href="/assets/brand/favicon.png"/>
<link rel="preconnect" href="https://fonts.googleapis.com"/><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,700..800&family=Plus+Jakarta+Sans:wght@500;600;700&display=swap" rel="stylesheet"/>
<style>
*{{box-sizing:border-box}}html{{color-scheme:dark}}
body{{margin:0;min-height:100dvh;background:#0C1333;color:#EEF1FF;font:500 16px/1.55 "Plus Jakarta Sans",system-ui,sans-serif;-webkit-font-smoothing:antialiased;
background-image:linear-gradient(rgba(160,180,255,.045) 1px,transparent 1px),linear-gradient(90deg,rgba(160,180,255,.045) 1px,transparent 1px);background-size:40px 40px}}
main{{max-width:440px;margin:0 auto;padding:20px 16px 32px;display:grid;gap:20px}}
header{{display:flex;align-items:center;gap:12px}}header img{{height:36px;width:auto}}
header b{{display:block;font:700 16px/1.2 "Bricolage Grotesque",sans-serif}}header span{{font-size:13px;color:#B3BDE6}}
h1{{margin:0;font:800 28px/1.05 "Bricolage Grotesque",sans-serif;letter-spacing:-.03em}}
.print{{justify-self:center;background:#F4F6FD;padding:8px;border-radius:14px;box-shadow:0 30px 60px -24px #000}}
.print img{{display:block;width:auto;max-width:100%;height:auto;max-height:58dvh;border-radius:6px}}
.actions{{display:grid;gap:10px}}
.btn{{display:flex;align-items:center;justify-content:center;gap:10px;min-height:56px;border-radius:999px;font:700 17px "Plus Jakarta Sans",sans-serif;text-decoration:none;border:0;cursor:pointer;color:#EEF1FF;background:transparent;box-shadow:inset 0 0 0 1.5px rgba(160,180,255,.34)}}
.btn.primary{{background:#5CB8D7;color:#04202B;box-shadow:0 10px 30px -12px rgba(92,184,215,.7)}}
.btn svg{{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}}
.btn:focus-visible{{outline:3px solid #fff;outline-offset:3px}}
p{{margin:0}}.muted{{color:#B3BDE6;font-size:14px}}.fine{{color:#8591C4;font-size:13px}}
</style></head>
<body><main>
<header><img src="/assets/brand/logo.png" alt="Laboratorium Teknik Komputer Unila" width="64" height="36"/><div><b>Photobooth Labkom</b><span>Dies Natalis Teknik Unila 2026</span></div></header>
<h1>Ini fotomu dari photobooth Labkom</h1>
<div class="print"><img src="{path}" alt="Foto photobooth Dies Natalis Teknik Unila 2026" width="1080" height="1920"/></div>
<div class="actions">
<a class="btn primary" href="{path}" download="photobooth-unila-2026.jpg"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>Unduh foto HD</a>
<button class="btn" id="share" type="button" hidden><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 15V3M7 8l5-5 5 5M5 13v7h14v-7"/></svg>Bagikan link</button>
<p class="muted">Di iPhone, jika foto terbuka di tab baru: tekan lama foto, lalu pilih Simpan ke Foto.</p>
</div>
<p class="fine">Link ini berlaku sampai {expires_text}. Setelah itu foto dihapus otomatis dari server.</p>
</main>
<script>
const b=document.getElementById('share');
if(navigator.share){{b.hidden=false;b.onclick=()=>navigator.share({{title:'Foto photobooth Dies Natalis Teknik Unila 2026',url:location.href}}).catch(()=>{{}});}}
</script>
</body></html>'''
    return HTMLResponse(html, headers={'X-Robots-Tag': 'noindex, nofollow'})


@app.get('/health')
def health():
    return {'ok': True, 'templates': len(TEMPLATES), 'maxBytes': MAX_BYTES}


if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host='0.0.0.0', port=8000)
