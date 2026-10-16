# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Event photobooth kiosk (Dies Natalis Teknik Unila 2026). FastAPI backend + vanilla HTML/CSS/JS frontend, no build step, no database. User-facing text and README are in Indonesian — keep new UI strings/error messages in Indonesian.

## Commands

```powershell
# Setup + run (Windows; start-windows.bat does the same)
py -3 -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe -m uvicorn server:app --reload --port 8800

# API smoke test (spawns its own server on port 17866, cleans up its data)
.venv\Scripts\python.exe tests/smoke_test.py

# Regenerate transparent template overlays + config.json from source-templates/
.venv\Scripts\python.exe generate_templates.py
```

```powershell
# UI flow in headless Chromium with a fake camera and mocked API (needs `pip install playwright` + `playwright install chromium`)
python tests/browser_synthetic.py   # optional env: CHROMIUM_PATH, SHOT_DIR (screenshots, default temp dir)
```

No linter or test framework is configured; tests are plain scripts with `assert`.

Env vars: `PUBLIC_BASE_URL` (URL embedded in QR/WhatsApp links; without it, links use the request host, so `localhost` QRs won't open on phones), `RETENTION_DAYS` (default 7; `0` = keep photos and contact data forever — no expiry check, no cleanup, `expires_at` stored as 0), `BASE_PATH` (sub-path prefix such as `/photobooth` when a reverse proxy strips it; every URL the server hands out — assets, API, `/files`, `/qr`, `/r`, admin — gets it back, and `page()` injects `window.BASE_PATH`/`window.RETENTION_DAYS` for the JS), `ADMIN_USER`/`ADMIN_PASSWORD` (default `labkom`/`123`), `ADMIN_SECRET` (cookie signing key; otherwise generated once into `data/.admin_secret`). `start-windows.bat` defaults `PUBLIC_BASE_URL` to `https://labkom.antiquetech.web.id`.

Linux server deploy (labkom.eng.unila.ac.id): app in `/var/www/PhotoBooth/photobooth`, venv `.venv-linux` (the tracked `.venv` is a Windows venv), systemd unit `photobooth.service` runs uvicorn on `127.0.0.1:8800` with `BASE_PATH=/photobooth RETENTION_DAYS=0 PUBLIC_BASE_URL=https://labkom.eng.unila.ac.id/photobooth`; Apache vhost `gamelab.conf` proxies `/photobooth/` there (same vhost also serves an unrelated game at `/`, `/api`, `/assets`). HTTPS terminates upstream of this server; the admin cookie is `Secure` only when the request is https (`is_https()`: scheme or `X-Forwarded-Proto`). Restart the service after code changes (`sudo systemctl restart photobooth`).

Public access: a Windows service `cloudflared` (dashboard-managed tunnel, token in `C:\ProgramData\cloudflared\token`) routes `labkom.antiquetech.web.id` → `http://localhost:8800`. Nothing tunnel-related lives in this repo. Uvicorn trusts `X-Forwarded-Proto` from localhost, so request URLs are https behind the tunnel.

## Architecture

**Asset caching** — Cloudflare caches `/assets/*` for hours. `homepage()` rewrites the `style.css`/`app.js` URLs in `index.html` to `?v=<mtime>`, `/api/templates` does the same for template PNG/preview URLs (`versioned()` in `server.py`) and `/api/stickers` for sticker files, so every changed file gets a new URL. Never link a changed asset without going through these. On Windows, uvicorn `--reload` can hang mid-reload and keep serving old code; for the live kiosk run without `--reload` and restart after changes (`config.json` is read at import).

**Flow** (`public/index.html` panes `#pane-register|template|camera|review|result`, switched by `showStep()` in `public/assets/app.js`): register name/program/WhatsApp → pick template → 120 s session, one press of the shutter shoots all missing photos (3 or 4 — `shotCount()` = `template.slots.length`; `state.photos`/`state.filters` are sized from it) automatically (5 s countdown with WebAudio beeps → capture + shutter sound → ~1 s preview → next; the shutter becomes a Berhenti/stop button meanwhile; a retake shoots one photo) (4:3 camera) → review with per-shot retake → confirm uploads → result page with QR/download/WhatsApp link.

**Compositing happens client-side.** `renderPoster()` in `app.js` draws each photo *cover-fit* into its slot rectangle (each photo with its own filter, `photoFx(i)`), then draws the template PNG **on top** with a soft canvas shadow so photos look recessed into the windows, then bakes stickers (`state.stickers`: `{emoji | src, x, y, size, rot}`, fractions of poster size; image stickers come from `/api/stickers`, which lists `public/assets/stickers/*.svg|png|webp` — SVGs need explicit `width`/`height` to draw on canvas). While editing, stickers are DOM buttons over the preview (`#sticker-layer`) and the preview canvas renders with `{ stickers: false }` to avoid drawing them twice. The final 2160×3840 JPEG is POSTed to `/api/results`. The server (`server.py`) re-validates, `ImageOps.fit`s to 2160×3840 with LANCZOS + unsharp mask (conventional upscale, not AI), and steps JPEG quality down until ≤20 MB.

**Effects** (Photo Booth/Mac style) — two independent choices per photo:
- `FILTERS` in `app.js` (groups `distort` / `color`) is used by the live strip (`#live-effects`), the 3×3 grid and the review filter tab. `css` entries go through `ctx.filter` (and `video.style.filter` live); `px` entries (Thermal, X-Ray, Pop Art, Komik, Pensil warna, Glow) are `ImageData` loops; `warp` entries (Bulge, Dent, Twirl, Squeeze, Mirror, Light Tunnel, Fish Eye, Stretch) remap pixels through an inverse-map lookup table from `WARPS`, cached per effect×size by `warpMap()`. `px`/`warp` (`fixedSize(f)`) run at `FX_SIZE` (800×600) for photos and `LIVE_FX_SIZE` (640×480) live so the look matches. Captured photos are always raw; the live effect is copied into `state.filters[shot]` and can be changed per photo in review (`state.filterTarget`: -1 = all).
- `OVERLAYS` (groups `face` / `scene`) are animated fun overlays: `FACE_FX` accessories (love, crown, cat/bunny ears, sunglasses, …) follow faces from the vendored MediaPipe FaceDetector (`public/assets/vendor/mediapipe/`, tasks-vision 0.10.14 + `blaze_face_short_range.tflite`, loaded lazily by `loadFaceDetector()`; boxes smoothed in `detectFaces()`; if the detector fails, `DEFAULT_FACE` is used); `SCENE_FX` fill the frame (confetti, snow, balloons, …). All particle positions are pure functions of time (`rand(i, k)`), so the capture matches the live frame. Overlays are drawn **on top of** the filter: live as video → effect → overlay in `#live-effect`; at capture `captureOverlayLayer()` stores a transparent 1600×1200 PNG in `state.layers[shot]` (mirrored like the photo), and `photoFx()`/`setThumb()` composite it after the filter. `state.overlays[shot]` remembers the id for retakes.
- The 3×3 grid (`#effect-grid`, `EFFECT_PAGES`, `pageItems()` puts Normal in the middle) renders live 240×180 tiles at ~12 fps in `gridLoop()`; the main live loop pauses while it is open.
`fxCache` holds one filtered+overlaid canvas per photo — keyed by filter id and layer, reset it when a photo changes.

**Admin panel** — `/admin` serves `public/admin.html` + `assets/admin.js` (search by name/program/WhatsApp, filter by program/frame, lightbox with HD download). Session = HMAC-signed `pb_admin` cookie (`admin_token()`/`is_admin()` in `server.py`, 12 h, `HttpOnly`, path `BASE_PATH`). Admin JSON/thumb/photo routes call `require_admin()`; thumbnails are cached in `data/thumbs/` and removed with the entry in `delete_entries()`. The admin sees every file still on disk regardless of the public link's expiry.

**Template pipeline** — three places must agree:
1. `source-templates/*-original.*` — original artwork (941×1672 PNG for decade/pink/sea/rusa; retro/blueprint are 1080×1920 and already have real transparent windows, loaded via `load_ready()`; akasha/tekling are 900×1600 **JPEG** with a 2×2 grid of 4 windows).
2. `generate_templates.py` — punches transparent windows (rounded-rect masks for decade/rusa; grey-checkerboard color-keying for pink/sea, since AI-generated "transparency" is just painted checkerboard), writes `public/assets/templates/{id}.png`, `{id}-preview.jpg`, and `config.json`.
3. `config.json` `slots` (x/y/w/h in art-pixel coords) — where photos are drawn behind the overlay. They are computed by `fit_slots()` from the real transparent window in each generated PNG (+`BLEED` px tucked under the frame); the coordinates in `PROCESSORS` are only search windows. Pink/sea/akasha/tekling windows come from color-keying the painted checkerboard (`key_checkerboard`, mask opened/closed to remove specks; JPEG sources need `bri_max=240` because compression brightens the light squares); decade/rusa use rounded-rect masks. `fit_slots()` searches only ±12 px around 4-slot approximations (±40 px otherwise) because the 2×2 gutters are ~30 px. Never hand-edit `config.json` — rerun the script. Server loads `config.json` at import time for `TEMPLATE_IDS` validation, so restart after regenerating.

**Storage** — SQLite `data/photobooth.db` (stdlib `sqlite3`, table `entries`: contact info, private; schema created at import in `server.py`, one short-lived connection per call via `db()`) and `data/results/{key}.jpg`, keyed by `secrets.token_urlsafe(16)`. Unguessable key is the only access control. `data/` must never be served statically. Expiry is enforced lazily in `get_entry()` (returns 410 and deletes) plus `tidy_old_results()` on startup, hourly, and on each upload. The public `/r/{key}` page must never expose name/phone/program (smoke test asserts this).

**WhatsApp** is a `wa.me` prefilled link only (`mode: 'manual_whatsapp'`) — no Business API, nothing is sent automatically. `valid_wa()` normalizes `0…` → `62…` and requires an Indonesian `628…` number.

## Coupling to watch

- Frontend constants in `app.js` (`SESSION_SECONDS`, `SHOT_COUNTDOWN`, `FINAL_SIZE`, `MAX_OUTPUT_SIZE`) mirror server `HD_SIZE`/`MAX_BYTES`; change both sides together, and the privacy text in `index.html`.
- `browser_synthetic.py` does literal string replacement on `const SHOT_COUNTDOWN = 5;`, the `style.css` `<link>` tag, and the `app.js` `<script>` tag — renaming/reformatting those lines silently breaks the test. It runs the 4-slot `akasha` template only (other template assets are blanked), drives the UI by id/class (`#field-*`, `#template-next`, `#capture-button`, `#confirm-button`, `.retake`, `.template-card[data-template]`, `#live-effects button`, `#filter-target .target-chip`, `#filter-grid .filter-chip`, `#sticker-grid`/`#emoji-grid .emoji-btn`, `#sticker-rotr`), matches effect chips by label text, reads `state.photos/filters/stickers` and calls `slotName()`, and checks steps via the `hidden` attribute on `#pane-*`.
- `smoke_test.py` asserts the template count from `config.json` and checks the admin panel (login `labkom`/`123`); keep it in sync with `ADMIN_USER`/`ADMIN_PASSWORD` defaults.
- `browser_synthetic.py` clicks the effect chips labelled `Thermal` and `Pop Art` — keep those labels.

## Styling

"Blueprint studio" look: Labkom navy (`--navy-*`) + logo cyan (`--cyan`), faint grid background, white print mats (`.print`) around posters. Plain CSS in `public/assets/style.css` with tokens on `:root`; no Tailwind or build step. Fonts: Bricolage Grotesque (display) + Plus Jakarta Sans (body) from Google Fonts, with system fallbacks for offline kiosks. Logo/favicon live in `public/assets/brand/`. `skylearn-DESIGN.md` is the previous design system and no longer applies.

Kiosk layout is one `100dvh` screen with no page scroll at ≥1100×640 (verified at 1920×1080 and 1366×768); container queries (`cqw`/`cqh`) size the camera, posters and template cards to fit. Below that breakpoint panes stack and the page scrolls.

Camera screen extras that depend on template data: the crop guide (`updateCropGuide`) dims the part of the 4:3 frame that `drawImageCover` will crop away for the current slot, the live poster/slot marks use `slots` coordinates as percentages of `artWidth`/`artHeight`, and `slotName()` derives "kiri atas"/"tengah"/… from slot positions. With 4 photos the review list uses tighter rows (`.review-shots[data-count="4"]`) to stay within 1366×768.
