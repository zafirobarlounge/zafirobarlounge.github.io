@echo off
setlocal

set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"

if not exist "%CHROME%" (
  echo Google Chrome no se encontro en la ubicacion habitual.
  echo Instala Google Chrome o ajusta la variable CHROME en este archivo.
  pause
  exit /b 1
)

set "ZAFIRO_PROFILE=%LOCALAPPDATA%\ZAFIRO\ChromePOSPrinting"
set "ZAFIRO_URL=http://localhost:5173/admin/pos?zafiro-kiosk-printing=1"

rem This is an isolated Chrome profile. It never reuses the user's regular profile.
start "ZAFIRO POS - impresion" "%CHROME%" --user-data-dir="%ZAFIRO_PROFILE%" --kiosk-printing --no-first-run --no-default-browser-check --new-window "%ZAFIRO_URL%"

endlocal
