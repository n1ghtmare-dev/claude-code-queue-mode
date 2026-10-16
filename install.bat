@echo off
setlocal
chcp 65001 >nul
title Claude Code Queue Mode
set "SCRIPT=%~dp0src\patch.js"
if not exist "%SCRIPT%" (
  echo Extract the whole archive first, then run this file from the extracted folder.
  goto :end
)
where node >nul 2>nul
if %errorlevel%==0 (
  node "%SCRIPT%" %*
  goto :end
)
rem No Node.js: run the patcher with the editor's own runtime.
for %%E in ("%LOCALAPPDATA%\Programs\cursor\Cursor.exe" "%ProgramFiles%\cursor\Cursor.exe" "%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe" "%ProgramFiles%\Microsoft VS Code\Code.exe" "%LOCALAPPDATA%\Programs\Windsurf\Windsurf.exe") do (
  if exist %%E (
    set ELECTRON_RUN_AS_NODE=1
    %%E "%SCRIPT%" %*
    goto :end
  )
)
echo Node.js was not found. Install it from https://nodejs.org and run this file again.
:end
echo.
pause
