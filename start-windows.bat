@echo off
title Live Translation Server

:: Move to the directory where this script is located
cd /d "%~dp0"

echo ==============================================
echo     Starting Live Translation Server...       
echo ==============================================

:: Ensure dependencies are installed
call npm install

:: Open the browser automatically
start https://localhost:5173

:: Start the Vite dev server
call npm run dev

pause
