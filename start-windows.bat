@echo off
title Live Translation Server
cd /d "%~dp0"

if exist "%~dp0windows\launch-live-translate.ps1" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\launch-live-translate.ps1" -Action Start -RepoRoot "%~dp0."
  if errorlevel 1 pause
  exit /b %ERRORLEVEL%
)

where node >nul 2>nul
if errorlevel 1 if exist "%~dp0..\node_binary\bin\node.exe" set "PATH=%~dp0..\node_binary\bin;%PATH%"

echo ==============================================
echo     Starting Live Translation Server...       
echo ==============================================

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20.19 or newer is required.
  pause
  exit /b 1
)
where npm >nul 2>nul
if errorlevel 1 (
  echo npm is required to start LiveTranslation.
  pause
  exit /b 1
)

call node scripts\runtime-state.js dependencies-ready >nul 2>nul
if errorlevel 1 call npm ci
if errorlevel 1 exit /b 1

call node scripts\runtime-state.js build-ready >nul 2>nul
if errorlevel 1 (
  call npm run build
  if errorlevel 1 exit /b 1
)

start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'https://localhost:5173'"

call npm start

pause
