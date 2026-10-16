"""Build real transparent photo windows from the provided event artwork.
Re-running requires every *-original source image in the source-templates directory.
Pure Pillow implementation (no numpy required).
"""
from pathlib import Path
import json
from PIL import Image, ImageDraw, ImageFilter, ImageChops

ROOT = Path(__file__).resolve().parent
OUT = ROOT / 'public' / 'assets' / 'templates'
OUT.mkdir(parents=True, exist_ok=True)

def key_checkerboard(im, rects, max_sat, bri_max=228):
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
                if sat <= max_sat and 95 <= bri <= bri_max:
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

def process_akasha():
    # JPEG source: compression lifts the light checker squares to ~230, so the brightness cap is higher.
    im = Image.open(ROOT / 'source-templates' / 'akasha-original.jpeg').convert('RGBA')
    return key_checkerboard(im, [(335, 640, 35, 440), (335, 640, 460, 865), (673, 978, 35, 440), (673, 978, 460, 865)], 16, 240)

def process_tekling():
    im = Image.open(ROOT / 'source-templates' / 'tekling-original.jpeg').convert('RGBA')
    return key_checkerboard(im, [(482, 765, 40, 445), (482, 765, 455, 860), (784, 1071, 40, 445), (784, 1071, 455, 860)], 16, 240)

def grow(mask, px):
    """Dilate (px > 0) or erode (px < 0) a mask by roughly |px| pixels using cheap 5x5 rank filters."""
    f = ImageFilter.MaxFilter(5) if px > 0 else ImageFilter.MinFilter(5)
    for _ in range(abs(px) // 2):
        mask = mask.filter(f)
    return mask

def blobs(mask, n):
    """(bbox, mask) of the n largest white blobs in an L mask, in reading order (pure-Pillow flood fill)."""
    m = mask.point(lambda v: 255 if v >= 128 else 0)
    px = m.load()
    found = []
    for y in range(0, m.height, 6):
        for x in range(0, m.width, 6):
            if px[x, y] == 255:
                ImageDraw.floodfill(m, (x, y), 100)
                blob = m.point(lambda v: 255 if v == 100 else 0)
                area = blob.histogram()[255]
                found.append((area, blob.getbbox(), blob if area > m.width * m.height // 200 else None))  # specks: no mask kept
                m.paste(0, mask=blob)
    found.sort(key=lambda f: f[0], reverse=True)
    if len(found) < n or found[n - 1][2] is None:
        raise SystemExit(f'Expected {n} photo windows, found blob areas {[f[0] for f in found[:n + 2]]}')
    # top-to-bottom; the small x weight orders windows that share a row left-to-right
    return sorted(((bb, blob) for _, bb, blob in found[:n]), key=lambda f: (f[0][1] + f[0][3]) / 2 + (f[0][0] + f[0][2]) / 2 * .01)

def hull_polygon(blob, tolerance=1.5):
    """Convex outline of a window (grown by BLEED), simplified to a few points. The client clips each photo to it,
    because tilted/staggered windows have overlapping bounding boxes."""
    blob = grow(blob, BLEED)
    x0, y0, x1, y1 = blob.getbbox()
    pts = []
    for y in range(y0, y1):
        row = blob.crop((x0, y, x1, y + 1)).getbbox()
        if row:
            pts += [(x0 + row[0], y), (x0 + row[2], y)]
    pts = sorted(set(pts))
    def cross(o, a, b): return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    def chain(points):
        out = []
        for q in points:
            while len(out) >= 2 and cross(out[-2], out[-1], q) <= 0: out.pop()
            out.append(q)
        return out[:-1]
    hull = chain(pts) + chain(pts[::-1])  # Andrew's monotone chain
    def rdp(line):
        a, b = line[0], line[-1]
        length = max(1e-9, ((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2) ** .5)
        dist = [abs(cross(a, b, q)) / length for q in line[1:-1]]
        if not dist or max(dist) <= tolerance: return [a, b]
        k = dist.index(max(dist)) + 1
        return rdp(line[:k + 1])[:-1] + rdp(line[k:])
    # a closed outline has no endpoints for RDP, so split it at the vertex farthest from the first one
    far = max(range(len(hull)), key=lambda i: (hull[i][0] - hull[0][0]) ** 2 + (hull[i][1] - hull[0][1]) ** 2)
    outline = rdp(hull[:far + 1])[:-1] + rdp(hull[far:] + hull[:1])[:-1]
    assert len(outline) >= 4, outline
    return [list(q) for q in outline]

def auto_slots(im, n):
    """Slots straight from the n largest transparent windows (+BLEED), for frames without hand-measured slots."""
    holes = im.getchannel('A').point(lambda v: 255 if v < 128 else 0)
    return [dict(x=x0 - BLEED, y=y0 - BLEED, w=x1 - x0 + 2 * BLEED, h=y1 - y0 + 2 * BLEED, r=0, clip=hull_polygon(blob))
            for (x0, y0, x1, y1), blob in blobs(holes, n)]

def key_white_checker(name, period=(7, 14)):
    """Painted checkerboards whose light squares are the same white as the frame border.
    Windows are found from the grey squares; a white pixel is only keyed when grey squares sit one
    square away both horizontally and vertically, which is true inside the checker grid but not on a
    plain white border running along the window."""
    im = Image.open(ROOT / 'source-templates' / f'{name}-original.png').convert('RGBA')
    pix = im.load()
    W, H = im.size
    def kind(x, y):  # 1 grey square, 2 white square candidate, 0 anything else
        r, g, b, _ = pix[x, y]
        if max(r, g, b) - min(r, g, b) > 14: return 0
        bri = (r + g + b) // 3
        return 1 if 185 <= bri <= 236 else 2 if bri > 236 else 0
    grey = Image.new('L', im.size, 0)
    gp = grey.load()
    for y in range(H):
        for x in range(W):
            if kind(x, y) == 1: gp[x, y] = 255
    region = grow(grow(grey, 12), -12)  # close: fill the white squares between grey ones
    region = grow(grow(region, -16), 16)  # open: drop thin grey lines and specks in the artwork
    area = grow(region, 14)  # search only around solid checker areas; auto_slots later checks there are n windows
    ap = area.load()
    mask = Image.new('L', im.size, 0)
    mp = mask.load()
    offsets = range(period[0], period[1] + 1)
    for y in range(H):
        for x in range(W):
            if not ap[x, y]: continue
            k = kind(x, y)
            if k == 1:
                mp[x, y] = 255
            elif k == 2:
                horiz = any(0 <= x + d < W and kind(x + d, y) == 1 for d in offsets) or any(0 <= x - d < W and kind(x - d, y) == 1 for d in offsets)
                vert = any(0 <= y + d < H and kind(x, y + d) == 1 for d in offsets) or any(0 <= y - d < H and kind(x, y - d) == 1 for d in offsets)
                if horiz and vert: mp[x, y] = 255
    mask = mask.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.MaxFilter(3))  # drop isolated keyed dots
    mask = mask.filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.MinFilter(5))  # fill leftover specks
    mask = mask.filter(ImageFilter.GaussianBlur(0.6))
    im.putalpha(ImageChops.subtract(im.getchannel('A'), mask))
    return im

def seal_strays(im, slots):
    """Keying also hits grey bits of the artwork (logo text, eyes); make everything outside the window outlines opaque again."""
    inside = Image.new('L', im.size, 0)
    d = ImageDraw.Draw(inside)
    for s in slots:
        d.polygon([tuple(p) for p in s['clip']], fill=255)
    im.putalpha(ImageChops.lighter(im.getchannel('A'), ImageChops.invert(inside)))
    return im

BLEED = 8  # px of photo tucked under the frame edge so anti-aliased borders never show white

def fit_slots(im, approx):
    """Snap each photo slot to the real transparent window (plus BLEED) so the photo is centred in the opening."""
    alpha = im.getchannel('A')
    pad = 40 if len(approx) <= 3 else 12  # 2x2 grids have ~30 px gutters; a wider search grabs the neighbouring window
    fitted = []
    for s in approx:
        box = (max(0, s['x'] - pad), max(0, s['y'] - pad),
               min(im.width, s['x'] + s['w'] + pad), min(im.height, s['y'] + s['h'] + pad))
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
    'akasha': (
        process_akasha,
        'Akasha Bahari',
        'Biru · Laut · Kapal',
        [
            dict(x=45, y=347, w=385, h=281, r=0),
            dict(x=470, y=347, w=385, h=281, r=0),
            dict(x=45, y=685, w=385, h=281, r=0),
            dict(x=470, y=685, w=385, h=281, r=0),
        ]
    ),
    'tekling': (
        process_tekling,
        'Teknik Lingkungan',
        'Hijau · Alam · Bumi',
        [
            dict(x=50, y=494, w=385, h=259, r=0),
            dict(x=465, y=494, w=385, h=259, r=0),
            dict(x=50, y=796, w=385, h=263, r=0),
            dict(x=465, y=796, w=385, h=263, r=0),
        ]
    ),
    # 4-photo collages: slots are found automatically (an int = number of windows instead of hand-measured slots).
    'kimia': (lambda: key_white_checker('kimia'), 'LABKOM × Teknik Kimia', 'Hitam · Lab · Kimia', 4),
    'lingkungan': (lambda: key_white_checker('lingkungan'), 'LABKOM × Teknik Lingkungan', 'Hijau · Kolase · Alam', 4),
    'pantai': (load_ready('pantai'), 'Pantai Teknik', 'Biru · Pantai · Kapal', 4),
    'akasha-labkom': (load_ready('akasha-labkom'), 'LABKOM × Akasha', 'Biru · Laut · Ombak', 4),
    'coding': (load_ready('coding'), 'LABKOM Coding', 'Biru · Komputer · Doodle', 4),
    'kawaii': (load_ready('kawaii'), 'Kawaii LABKOM', 'Pink · Coding · Lucu', 4),
    'monyet': (lambda: key_white_checker('monyet'), 'Monyet Ceria', 'Hutan · Pisang · Lucu', 4),
    'tayo': (lambda: key_white_checker('tayo'), 'Tayo Bus', 'Bus · Kota · Ceria', 4),
}

configs = []
for tid, (fn, title, desc, approx_slots) in PROCESSORS.items():
    print('…', tid, flush=True)  # keying the white-checker frames takes a while
    im = fn()
    if isinstance(approx_slots, int):
        slots = auto_slots(im, approx_slots)
        im = seal_strays(im, slots)
    else:
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
