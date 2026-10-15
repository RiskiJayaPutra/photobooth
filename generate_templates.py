"""Build real transparent photo windows from the provided event artwork.
Re-running requires the four source templates in the source-templates directory.
Pure Pillow implementation (no numpy required).
"""
from pathlib import Path
import json
from PIL import Image, ImageDraw, ImageFilter, ImageChops

ROOT = Path(__file__).resolve().parent
OUT = ROOT / 'public' / 'assets' / 'templates'
OUT.mkdir(parents=True, exist_ok=True)

def key_checkerboard(im, rects, max_sat):
    """Make the painted grey checkerboard inside each rect transparent.
    rects are (y0, y1, x0, x1). The keyed mask is opened/closed so stray specks
    don't punch pin-holes into the frame border or leave grey dots on the photo."""
    pix = im.load()
    mask = Image.new('L', im.size, 0)
    mpix = mask.load()
    for y0, y1, x0, x1 in rects:
        for y in range(y0, y1):
            for x in range(x0, x1):
                r, g, b, a = pix[x, y]
                sat = max(r, g, b) - min(r, g, b)
                bri = (r + g + b) // 3
                if sat <= max_sat and 95 <= bri <= 228:
                    mpix[x, y] = 255
    mask = mask.filter(ImageFilter.MinFilter(5)).filter(ImageFilter.MaxFilter(5))  # drop isolated keyed dots
    mask = mask.filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.MinFilter(5))  # fill leftover grey specks
    mask = mask.filter(ImageFilter.GaussianBlur(0.6))
    im.putalpha(ImageChops.subtract(im.getchannel('A'), mask))
    return im

def process_pink():
    im = Image.open(ROOT / 'source-templates' / 'pink-original.png').convert('RGBA')
    return key_checkerboard(im, [(305, 610, 260, 830), (695, 1010, 120, 700), (1105, 1425, 260, 830)], 24)

def process_sea():
    im = Image.open(ROOT / 'source-templates' / 'sea-original.png').convert('RGBA')
    return key_checkerboard(im, [(180, 530, 260, 810), (650, 1000, 130, 690), (1100, 1435, 260, 830)], 18)

BLEED = 8  # px of photo tucked under the frame edge so anti-aliased borders never show white

def fit_slots(im, approx):
    """Snap each photo slot to the real transparent window (plus BLEED) so the photo is centred in the opening."""
    alpha = im.getchannel('A')
    fitted = []
    for s in approx:
        box = (max(0, s['x'] - 40), max(0, s['y'] - 40),
               min(im.width, s['x'] + s['w'] + 40), min(im.height, s['y'] + s['h'] + 40))
        bb = alpha.crop(box).point(lambda v: 255 if v < 128 else 0).getbbox()
        if not bb:
            raise SystemExit(f'No transparent window found near slot {s}')
        x0, y0, x1, y1 = bb[0] + box[0], bb[1] + box[1], bb[2] + box[0], bb[3] + box[1]
        fitted.append(dict(x=x0 - BLEED, y=y0 - BLEED, w=x1 - x0 + 2 * BLEED, h=y1 - y0 + 2 * BLEED, r=0))
    return fitted

def process_rusa():
    im = Image.open(ROOT / 'source-templates' / 'rusa-original.png').convert('RGBA')
    slots = [
        (271, 292, 783, 658, 54),
        (164, 715, 676, 1080, 54),
        (271, 1134, 783, 1500, 54)
    ]
    mask = Image.new('L', im.size, 0)
    d = ImageDraw.Draw(mask)
    for x0, y0, x1, y1, r in slots:
        d.rounded_rectangle((x0, y0, x1, y1), radius=r, fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(0.5))
    alpha = im.getchannel('A')
    alpha = ImageChops.subtract(alpha, mask)
    im.putalpha(alpha)
    return im

def load_ready(name):
    """Source artwork that already has real transparent windows (no keying or masking needed)."""
    return lambda: Image.open(ROOT / 'source-templates' / f'{name}-original.png').convert('RGBA')

def process_decade():
    im = Image.open(ROOT / 'source-templates' / 'decade-original.png').convert('RGBA')
    slots = [
        (253, 321, 878, 646, 16),
        (65, 741, 684, 1066, 16),
        (265, 1156, 882, 1486, 16)
    ]
    mask = Image.new('L', im.size, 0)
    d = ImageDraw.Draw(mask)
    for x0, y0, x1, y1, r in slots:
        d.rounded_rectangle((x0, y0, x1, y1), radius=r, fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(0.5))
    alpha = im.getchannel('A')
    alpha = ImageChops.subtract(alpha, mask)
    im.putalpha(alpha)
    return im

PROCESSORS = {
    'decade': (
        process_decade,
        'Kamen Rider Decade',
        'Magenta · Black · Tech',
        [
            dict(x=242, y=310, w=648, h=348, r=0),
            dict(x=54, y=730, w=642, h=348, r=0),
            dict(x=254, y=1145, w=640, h=352, r=0),
        ]
    ),
    'pink': (
        process_pink,
        'Pink Kawaii',
        'Pink · Cute · Bear',
        [
            dict(x=250, y=300, w=585, h=315, r=0),
            dict(x=110, y=690, w=595, h=325, r=0),
            dict(x=250, y=1100, w=585, h=330, r=0),
        ]
    ),
    'sea': (
        process_sea,
        'Sea Friends',
        'Blue · Ocean · Chibi',
        [
            dict(x=250, y=175, w=565, h=360, r=0),
            dict(x=120, y=645, w=575, h=360, r=0),
            dict(x=250, y=1095, w=565, h=345, r=0),
        ]
    ),
    'rusa': (
        process_rusa,
        'Rusa Unila',
        'Green · Campus · Mascot',
        [
            dict(x=255, y=282, w=540, h=388, r=0),
            dict(x=148, y=705, w=540, h=388, r=0),
            dict(x=255, y=1124, w=540, h=388, r=0),
        ]
    ),
    'retro': (
        load_ready('retro'),
        'Retro Arcade',
        'Pixel · Neon · Game',
        [
            dict(x=260, y=330, w=751, h=430, r=0),
            dict(x=70, y=820, w=751, h=430, r=0),
            dict(x=260, y=1310, w=751, h=431, r=0),
        ]
    ),
    'blueprint': (
        load_ready('blueprint'),
        'Blueprint Teknik',
        'Biru · Gear · Engineering',
        [
            dict(x=260, y=330, w=751, h=430, r=0),
            dict(x=70, y=820, w=751, h=430, r=0),
            dict(x=260, y=1310, w=751, h=431, r=0),
        ]
    ),
}

configs = []
for tid, (fn, title, desc, approx_slots) in PROCESSORS.items():
    im = fn()
    slots = fit_slots(im, approx_slots)
    im.save(OUT / f'{tid}.png', optimize=True)
    
    # Generate clean preview thumbnail
    thumb = Image.new('RGBA', im.size, '#f0f3fa')
    thumb.alpha_composite(im)
    thumb.thumbnail((540, 960), Image.Resampling.LANCZOS)
    thumb.convert('RGB').save(OUT / f'{tid}-preview.jpg', quality=88, optimize=True)
    
    configs.append(dict(
        id=tid,
        title=title,
        desc=desc,
        slots=slots,
        artWidth=im.width,
        artHeight=im.height,
        asset=f'/assets/templates/{tid}.png',
        preview=f'/assets/templates/{tid}-preview.jpg'
    ))

(OUT / 'config.json').write_text(json.dumps(configs, ensure_ascii=False, indent=2), encoding='utf-8')
print('Generated', len(configs), 'transparent templates with photo-behind layout')
