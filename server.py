"""Labkom Photobooth — local FastAPI server.

Run: python -m uvicorn server:app --reload --port 8000
Deploy with PUBLIC_BASE_URL=https://photobooth.example.com.
"""
from __future__ import annotations

import io
import asyncio
from contextlib import asynccontextmanager
import json
import os
import re
import secrets
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
ENTRIES = DATA / 'entries'
for folder in (FILES, ENTRIES):
    folder.mkdir(parents=True, exist_ok=True)
TEMPLATES = json.loads((PUBLIC / 'assets' / 'templates' / 'config.json').read_text(encoding='utf-8'))
TEMPLATE_IDS = {t['id'] for t in TEMPLATES}
MAX_BYTES = 20 * 1024 * 1024
RETENTION_DAYS = int(os.getenv('RETENTION_DAYS', '7'))
HD_SIZE = (2160, 3840)
PUBLIC_BASE_URL = os.getenv('PUBLIC_BASE_URL', '').rstrip('/')
Image.MAX_IMAGE_PIXELS = 32_000_000
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


def entry_path(key: str) -> Path:
    if not re.fullmatch(r'[A-Za-z0-9_-]{12,40}', key):
        raise HTTPException(404, 'Hasil foto tidak ditemukan.')
    return ENTRIES / f'{key}.json'


def get_entry(key: str) -> dict:
    file = entry_path(key)
    if not file.exists():
        raise HTTPException(404, 'Hasil foto tidak ditemukan.')
    try:
        entry = json.loads(file.read_text(encoding='utf-8'))
    except ValueError:
        raise HTTPException(404, 'Hasil foto tidak ditemukan.')
    if entry['expires_at'] <= time.time():
        try:
            file.unlink(missing_ok=True)
            (FILES / f'{key}.jpg').unlink(missing_ok=True)
        finally:
            raise HTTPException(410, 'Masa penyimpanan hasil foto telah berakhir.')
    return entry


def result_url(request: Request, key: str) -> str:
    base = PUBLIC_BASE_URL or str(request.base_url).rstrip('/')
    return f'{base}/r/{key}'


def tidy_old_results() -> None:
    now = time.time()
    for item in ENTRIES.glob('*.json'):
        try:
            data = json.loads(item.read_text(encoding='utf-8'))
            if data['expires_at'] < now:
                item.unlink(missing_ok=True)
                (FILES / (item.stem + '.jpg')).unlink(missing_ok=True)
        except (KeyError, OSError, ValueError):
            continue


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
    data = dict(id=key, name=name, program=program, whatsapp=phone,
                template_id=template_id, created_at=created, expires_at=expire,
                image_bytes=len(packed))
    (ENTRIES / f'{key}.json').write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
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
    get_entry(key)
    # Public view never exposes name, phone, or program.
    # The unguessable URL acts as a private share link until expiry.
    path = f'/files/{key}.jpg'
    html = f'''<!doctype html><html lang="id"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="robots" content="noindex,nofollow"/>
<title>Hasil Photobooth — Dies Natalis Teknik Unila 2026</title>
<style>body{{background:#101426;color:#fff;font-family:system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center}}
main{{max-width:400px;text-align:center;padding:28px 16px}}img{{max-width:100%;max-height:70vh;border-radius:14px;box-shadow:0 20px 40px #0007}}
a{{display:inline-block;background:#e63494;color:#fff;padding:13px 24px;border-radius:12px;font-weight:700;text-decoration:none;margin-top:16px}}</style></head>
<body><main><h2>Hasil Photobooth Kamu ✨</h2><p>Dies Natalis Teknik Unila 2026</p><img src="{path}" alt="Foto photobooth"/><p><a href="{path}" download="photobooth-unila-2026.jpg">Unduh Foto HD</a></p>
<small>Link hanya berlaku selama {RETENTION_DAYS} hari sejak foto dibuat.</small></main></body></html>'''
    return HTMLResponse(html, headers={'X-Robots-Tag': 'noindex, nofollow'})


@app.get('/health')
def health():
    return {'ok': True, 'templates': len(TEMPLATES), 'maxBytes': MAX_BYTES}


if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host='0.0.0.0', port=8000)
