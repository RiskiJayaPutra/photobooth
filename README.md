# LABKOM Photobooth — Dies Natalis Teknik Unila 2026

Website photobooth siap dijalankan untuk acara Dies Natalis Teknik Unila. Dibuat dengan **FastAPI (Python)** dan **HTML/CSS/JavaScript murni**. Tidak memerlukan database atau akun layanan berbayar untuk fungsi QR dan unduh foto.

## Fitur yang sudah tersedia

- Peserta mengisi **nama, program studi, dan nomor WhatsApp**, serta persetujuan penyimpanan sementara.
- Memilih salah satu dari **4 template asli**: Kamen Rider Decade, Pink Kawaii, Sea Friends, Rusa Unila.
- **Sesi 2 menit** dimulai setelah kamera siap. Setiap foto 1, 2, dan 3 membutuhkan tombol **Mulai Foto** tersendiri dan countdown **5 detik**.
- Kamera menggunakan rasio **4:3**; foto otomatis diposisikan dan di-*crop* mengikuti lubang foto pada desain template (beberapa gambar desain asli memiliki proporsi lubang yang tidak persis 4:3).
- Pratinjau hasil gabungan dan opsi **retake tiap foto** selama waktu sesi tersisa. Setelah waktu habis, peserta masih bisa konfirmasi bila sudah memiliki ketiga foto.
- Output ditingkatkan ke **2160 × 3840 px (9:16)** menggunakan resampling berkualitas tinggi dan sharpening. Ini **upscale konvensional**, **bukan** AI super-resolution; proses ini tidak dapat menciptakan detail kamera yang tidak tertangkap. Hasil otomatis dikompresi menjadi **JPG maksimal 20 MB**.
- Halaman unduh, **QR code**, tombol salin link, dan pilihan **WhatsApp**. WhatsApp membuka chat dengan teks/link siap kirim; **tidak mengirim otomatis** tanpa integrasi resmi WhatsApp Business API.
- Hasil disimpan sampai **7 hari secara default**. Pembersihan otomatis dijalankan saat server mulai, setiap satu jam saat aktif, serta ketika hasil baru diunggah. URL foto berupa token acak yang sukar ditebak.

## Menjalankan di Windows

1. Instal [Python 3.11+](https://www.python.org/downloads/) dan centang **Add Python to PATH** saat instalasi.
2. Ekstrak ZIP proyek ini ke folder yang tidak memiliki pembatasan akses.
3. Klik dua kali **`start-windows.bat`**. Saat dijalankan pertama kali, script akan membuat lingkungan Python lokal (`.venv`) dan memasang dependensi (memerlukan koneksi internet saat instalasi awal).
4. Setelah muncul `Uvicorn running on http://0.0.0.0:8000`, buka browser Chrome atau Edge pada **`http://localhost:8000`** di komputer photobooth.
5. Izinkan akses kamera. Jangan tutup jendela terminal selama acara.

Jika file BAT gagal, jalankan manual menggunakan PowerShell di folder proyek:

```powershell
py -3 -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe -m uvicorn server:app --host 0.0.0.0 --port 8000
```

Linux/macOS:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m uvicorn server:app --host 0.0.0.0 --port 8000
```

## Penting: cara agar QR bisa dibuka peserta

**Jika kiosk berjalan di `http://localhost:8000`**, QR yang mengarah ke `localhost` **tidak akan bekerja di HP peserta**, karena `localhost` di HP berarti HP itu sendiri.

**Pilihan A — Jaringan Wi-Fi acara (tanpa domain):** Pastikan PC photobooth dan HP peserta berada pada jaringan yang sama, PC dan browser diizinkan lewat firewall, dan mengetahui alamat IP lokal PC, misalnya `192.168.1.25`. Saat menjalankan server, atur `PUBLIC_BASE_URL=http://192.168.1.25:8000`:

```powershell
$env:PUBLIC_BASE_URL = 'http://192.168.1.25:8000'
.venv\Scripts\python.exe -m uvicorn server:app --host 0.0.0.0 --port 8000
```

Buka photobooth melalui **`http://localhost:8000`** di PC agar izin kamera berfungsi. QR nantinya menunjuk ke IP jaringan yang dapat diakses HP. Di jaringan kampus, *client isolation* dan firewall mungkin perlu diatur; HTTP lokal tidak ideal untuk distribusi data pribadi di jaringan publik.

**Pilihan B — Hosting publik:** Deploy website di server dengan **domain HTTPS** dan penyimpanan persisten, lalu atur `PUBLIC_BASE_URL=https://domain-kamu.example`. Solusi ini paling sesuai bila QR harus dibuka di mana pun dan link WhatsApp harus dapat digunakan di luar Wi-Fi acara. Kamera pada browser membutuhkan **HTTPS atau localhost**, bukan alamat HTTP IP biasa.

> Jangan menggunakan `PUBLIC_BASE_URL` yang tidak bisa dijangkau pengguna. Belum ada integrasi WhatsApp Business API; tombol WhatsApp memerlukan pengguna/operator menekan **Send** di WhatsApp.

## Konfigurasi

Semua pengaturan dapat diberikan sebagai environment variable sebelum menjalankan server:

| Variabel | Default | Kegunaan |
|---|---|---|
| `PUBLIC_BASE_URL` | mengikuti domain request | URL yang tertanam dalam QR dan pesan WA |
| `RETENTION_DAYS` | `7` | Lama penyimpanan data dan gambar |

Konstanta pada `public/assets/app.js` untuk pengembangan: `SESSION_SECONDS=120`, `SHOT_COUNTDOWN=5`, `FINAL_SIZE=2160×3840`, dan ukuran output 20 MB. Jika mengubah parameter tampilan, sesuaikan juga server dan pemberitahuan privasi.

## Struktur proyek

```text
labkom-photobooth/
├── server.py                      # API, penyimpanan, QR, halaman hasil
├── public/
│   ├── index.html                # seluruh tahap UI
│   └── assets/
│       ├── app.js                # kamera, timer, retake, gabung foto
│       ├── style.css
│       └── templates/
│           ├── config.json      # koordinat foto setiap template
│           ├── {decade,pink,sea,rusa}.png
│           └── *-preview.jpg
├── source-templates/             # desain asli dari pengguna
├── generate_templates.py         # regenerasi overlay transparan
├── requirements.txt
├── start-windows.bat
└── data/                            # dibuat otomatis, JANGAN unggah publik
    ├── photobooth.db               # SQLite: data peserta (privat)
    └── results/                    # foto hasil (privat)
```

### Menyesuaikan area transparan foto

Template yang dihasilkan dari AI umumnya hanya **menggambar motif kotak-kotak**, sehingga belum benar-benar transparan. Script `generate_templates.py` memotong tiga jendela foto dari desain asal dan membuat PNG dengan alpha transparan asli. Untuk memindahkan/mengubah area foto, ubah daftar koordinat `slots=[[x0,y0,x1,y1,radius],...]` dalam script lalu jalankan:

```bash
python generate_templates.py
```

**Penting:** Area jendela mengikuti letak desain gambar asli. Jika diganti dengan frame baru, penyesuaian koordinat manual diperlukan, terutama jika maskot menutupi sudut frame.

## Catatan produksi & privasi

- Pastikan peserta memahami bahwa nomor WhatsApp disimpan sementara, foto dapat diakses siapa saja yang memiliki link, dan pihak acara memiliki tanggung jawab untuk memperoleh persetujuan dan melindungi data.
- Gunakan PC/kiosk khusus, jaga akses folder `data/` (jangan jadikan static/public), serta pastikan perangkat memiliki ruang kosong memadai.
- Gunakan HTTPS dan pembatasan unggahan/rate limiting sebelum membuka server untuk trafik internet publik. Contoh ini adalah **MVP untuk acara**, belum paket keamanan enterprise.
- Siapkan koneksi internet yang stabil jika menggunakan hosting atau WhatsApp. QR lokal di jaringan acara dapat bekerja tanpa akses internet setelah aplikasi terinstal, selama koneksi LAN tetap tersedia.
- Rasio 4:3 untuk **pengambilan kamera**, tetapi masing-masing template memiliki bukaan art yang berbeda dari desain sumber. Foto akan di-*crop* agar tidak meninggalkan ruang kosong.
- Untuk **AI upscale sejati** (misalnya Real-ESRGAN), perlu model/layanan pemrosesan tambahan dan uji performa; fitur itu **belum** termasuk.

## Alur pengujian di tempat acara

1. Isi data peserta contoh.
2. Pilih satu template, izinkan kamera.
3. Tekan Mulai Foto 1, tunggu 5 detik; ulangi untuk Foto 2 dan 3.
4. Lihat pratinjau, lakukan retake foto nomor 2, pastikan hanya foto itu yang berubah.
5. Klik Konfirmasi, verifikasi resolusi hasil unduhan (2160 × 3840) dan ukuran file (tidak lebih 20 MB).
6. Scan QR menggunakan HP pada jaringan yang sesuai; verifikasi halaman hasil dan unduhan.
7. Coba WhatsApp; pastikan ada pesan siap dikirim ke nomor yang dimasukkan.
