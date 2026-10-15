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

Env vars: `PUBLIC_BASE_URL` (URL embedded in QR/WhatsApp links; without it, links use the request host, so `localhost` QRs won't open on phones), `RETENTION_DAYS` (default 7). `start-windows.bat` defaults `PUBLIC_BASE_URL` to `https://labkom.antiquetech.web.id`.

Public access: a Windows service `cloudflared` (dashboard-managed tunnel, token in `C:\ProgramData\cloudflared\token`) routes `labkom.antiquetech.web.id` → `http://localhost:8800`. Nothing tunnel-related lives in this repo. Uvicorn trusts `X-Forwarded-Proto` from localhost, so request URLs are https behind the tunnel.

## Architecture

**Asset caching** — Cloudflare caches `/assets/*` for hours. `homepage()` rewrites the `style.css`/`app.js` URLs in `index.html` to `?v=<mtime>` and `/api/templates` does the same for template PNG/preview URLs (`versioned()` in `server.py`), so every changed file gets a new URL. Never link a changed asset without going through these. On Windows, uvicorn `--reload` can hang mid-reload and keep serving old code; for the live kiosk run without `--reload` and restart after changes (`config.json` is read at import).

**Flow** (`public/index.html` panes `#pane-register|template|camera|review|result`, switched by `showStep()` in `public/assets/app.js`): register name/program/WhatsApp → pick template → 120 s session, one press of the shutter shoots all missing photos automatically (5 s countdown with WebAudio beeps → capture + shutter sound → ~1 s preview → next; the shutter becomes a Berhenti/stop button meanwhile; a retake shoots one photo) (4:3 camera) → review with per-shot retake → confirm uploads → result page with QR/download/WhatsApp link.

**Compositing happens client-side.** `renderPoster()` in `app.js` draws each photo *cover-fit* into its slot rectangle (with the review-step CSS filter via `ctx.filter`), then draws the template PNG **on top** with a soft canvas shadow so photos look recessed into the windows, then bakes emoji stickers (`state.stickers`, fractions of poster size). While editing, stickers are DOM buttons over the preview (`#sticker-layer`) and the preview canvas renders with `{ stickers: false }` to avoid drawing them twice. The final 2160×3840 JPEG is POSTed to `/api/results`. The server (`server.py`) re-validates, `ImageOps.fit`s to 2160×3840 with LANCZOS + unsharp mask (conventional upscale, not AI), and steps JPEG quality down until ≤20 MB.

**Template pipeline** — three places must agree:
1. `source-templates/*-original.png` — original artwork (941×1672 for decade/pink/sea/rusa; retro/blueprint are 1080×1920 and already have real transparent windows, loaded via `load_ready()`).
2. `generate_templates.py` — punches transparent windows (rounded-rect masks for decade/rusa; grey-checkerboard color-keying for pink/sea, since AI-generated "transparency" is just painted checkerboard), writes `public/assets/templates/{id}.png`, `{id}-preview.jpg`, and `config.json`.
3. `config.json` `slots` (x/y/w/h in art-pixel coords) — where photos are drawn behind the overlay. They are computed by `fit_slots()` from the real transparent window in each generated PNG (+`BLEED` px tucked under the frame); the coordinates in `PROCESSORS` are only search windows. Pink/sea windows come from color-keying the painted checkerboard (`key_checkerboard`, mask opened/closed to remove specks); decade/rusa use rounded-rect masks. Never hand-edit `config.json` — rerun the script. Server loads `config.json` at import time for `TEMPLATE_IDS` validation, so restart after regenerating.

**Storage** — SQLite `data/photobooth.db` (stdlib `sqlite3`, table `entries`: contact info, private; schema created at import in `server.py`, one short-lived connection per call via `db()`) and `data/results/{key}.jpg`, keyed by `secrets.token_urlsafe(16)`. Unguessable key is the only access control. `data/` must never be served statically. Expiry is enforced lazily in `get_entry()` (returns 410 and deletes) plus `tidy_old_results()` on startup, hourly, and on each upload. The public `/r/{key}` page must never expose name/phone/program (smoke test asserts this).

**WhatsApp** is a `wa.me` prefilled link only (`mode: 'manual_whatsapp'`) — no Business API, nothing is sent automatically. `valid_wa()` normalizes `0…` → `62…` and requires an Indonesian `628…` number.

## Coupling to watch

- Frontend constants in `app.js` (`SESSION_SECONDS`, `SHOT_COUNTDOWN`, `FINAL_SIZE`, `MAX_OUTPUT_SIZE`) mirror server `HD_SIZE`/`MAX_BYTES`; change both sides together, and the privacy text in `index.html`.
- `browser_synthetic.py` does literal string replacement on `const SHOT_COUNTDOWN = 5;`, the `style.css` `<link>` tag, and the `app.js` `<script>` tag — renaming/reformatting those lines silently breaks the test. It also drives the UI by id (`#field-*`, `#template-next`, `#capture-button`, `#confirm-button`, `.retake`, `.template-card[data-template]`), counts captured shots via `#shot-slots img`, and checks steps via the `hidden` attribute on `#pane-*`.

## Styling

"Blueprint studio" look: Labkom navy (`--navy-*`) + logo cyan (`--cyan`), faint grid background, white print mats (`.print`) around posters. Plain CSS in `public/assets/style.css` with tokens on `:root`; no Tailwind or build step. Fonts: Bricolage Grotesque (display) + Plus Jakarta Sans (body) from Google Fonts, with system fallbacks for offline kiosks. Logo/favicon live in `public/assets/brand/`. `skylearn-DESIGN.md` is the previous design system and no longer applies.

Kiosk layout is one `100dvh` screen with no page scroll at ≥1100×640 (verified at 1920×1080 and 1366×768); container queries (`cqw`/`cqh`) size the camera, posters and template cards to fit. Below that breakpoint panes stack and the page scrolls.

Camera screen extras that depend on template data: the crop guide (`updateCropGuide`) dims the part of the 4:3 frame that `drawImageCover` will crop away for the current slot, and the live poster/slot marks use `slots` coordinates as percentages of `artWidth`/`artHeight`.
