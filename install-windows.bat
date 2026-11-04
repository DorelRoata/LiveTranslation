@echo off
title Live Translate Windows Installer
cd /d "%~dp0"

echo ==============================================================
echo        Installing Live Translate for Windows...
echo ==============================================================

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\launch-live-translate.ps1" -Action Install -RepoRoot "%~dp0."
if errorlevel 1 (
  echo.
  echo Installation encountered an error.
  pause
  exit /b 1
)
