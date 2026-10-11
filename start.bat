@echo off
setlocal
cd /d "%~dp0"
title Claude Web UI

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js is not installed. Download the LTS version from https://nodejs.org
  echo  then run this file again.
  echo.
  pause
  exit /b 1
)

where git >nul 2>nul
if not errorlevel 1 if exist .git (
  echo Checking for updates...
  git pull --ff-only --quiet
  if errorlevel 1 echo  Could not update automatically. Starting the version you have.
)

if not exist node_modules echo Installing dependencies, this happens only once...
call npm install --no-fund --no-audit --silent
if errorlevel 1 (
  if not exist node_modules (
    echo.
    echo  npm install failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
  echo  Could not refresh dependencies. Starting anyway.
)

node scripts/launch.mjs
pause
