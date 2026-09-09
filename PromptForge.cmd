@echo off
rem Double-click to run PromptForge. Starts the local page server (minimised) and opens the app in
rem your browser at http://localhost:5173 - the address local models such as Ollama accept.
rem Closing the minimised "PromptForge server" window stops it. Needs Node.js (https://nodejs.org).
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install it from https://nodejs.org and try again.
  pause
  exit /b 1
)
rem Keep a startup error visible so a busy port is not mistaken for a successful launch.
start "PromptForge server" /min cmd /c "node serve.mjs --open || pause"
