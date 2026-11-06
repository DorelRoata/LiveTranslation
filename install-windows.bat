@echo off
title Live Translate Windows Installer
cd /d "%~dp0"

if not exist "%~dp0windows\launch-live-translate.ps1" (
  echo ==============================================================
  echo   Downloading Live Translate for Windows...
  echo ==============================================================
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; $rel=Invoke-RestMethod -Uri 'https://api.github.com/repos/DorelRoata/LiveTranslation/releases/latest' -Headers @{'User-Agent'='LiveTranslate-Bootstrap'}; $asset=($rel.assets | Where-Object { $_.name -match 'Windows.*\.zip$' } | Select-Object -First 1); if (-not $asset) { throw 'Could not find LiveTranslate-Windows.zip in the latest release.' }; $tmp=Join-Path $env:TEMP ('lt-bootstrap-' + $PID); New-Item -ItemType Directory -Force -Path $tmp | Out-Null; $zip=Join-Path $tmp 'LiveTranslate-Windows.zip'; Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip -UseBasicParsing; Expand-Archive -Path $zip -DestinationPath $tmp -Force; $inner=Get-ChildItem -Path $tmp -Directory | Select-Object -First 1; & (Join-Path $inner.FullName 'windows\launch-live-translate.ps1') -Action Install -RepoRoot $inner.FullName; Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue"
  if errorlevel 1 (
    echo.
    echo Installation encountered an error.
    pause
    exit /b 1
  )
  exit /b 0
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\launch-live-translate.ps1" -Action Install -RepoRoot "%~dp0."
if errorlevel 1 (
  echo.
  echo Installation encountered an error.
  pause
  exit /b 1
)
