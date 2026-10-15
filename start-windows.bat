@echo off
setlocal
cd /d "%~dp0"
echo ==============================================
echo  LABKOM PHOTOBOOTH - DIES NATALIS UNILA 2026
echo ==============================================
where py >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    set "PYTHON=py -3"
) else (
    set "PYTHON=python"
)
if not exist ".venv\Scripts\python.exe" (
    echo Membuat virtual environment...
    %PYTHON% -m venv .venv
    if errorlevel 1 goto :error
)
echo Memeriksa dependensi...
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 goto :error
echo.
echo Website akan tersedia di: http://localhost:8000
echo Pastikan kamera diizinkan di browser.
echo Tekan Ctrl+C untuk menghentikan server.
echo.
".venv\Scripts\python.exe" -m uvicorn server:app --host 0.0.0.0 --port 8000
pause
exit /b 0
:error
echo GAGAL. Pastikan Python 3.11+ dan koneksi internet tersedia.
pause
exit /b 1
