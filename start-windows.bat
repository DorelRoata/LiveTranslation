@echo off
title Live Translation Server

:: Move to the directory where this script is located
cd /d "%~dp0"

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

:: Install only on first setup. Routine launches never contact the package registry.
if not exist node_modules call npm ci
if errorlevel 1 exit /b 1

call npm run build
if errorlevel 1 exit /b 1

:: Open the browser automatically
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'https://localhost:5173'"

:: Start the production local server
call npm start

pause
