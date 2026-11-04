@echo off
title Live Translate Updater
cd /d "%~dp0"

echo ==============================================================
echo        Checking for Live Translate Updates...
echo ==============================================================

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\launch-live-translate.ps1" -Action Update -RepoRoot "%~dp0."
if errorlevel 1 (
  echo.
  echo Update encountered an error.
  pause
  exit /b 1
)
