#!/usr/bin/env node
/*
 * Maintainer script.
 *
 *   node scripts/build.js          regenerate install.bat / uninstall.bat (CRLF)
 *   node scripts/build.js --dist   also build dist/claude-code-queue-mode.zip and .tar.gz for a release
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..');
const NAME = 'claude-code-queue-mode';
const DIST_FILES = ['README.md', 'README.ru.md', 'LICENSE', 'CHANGELOG.md', 'install.bat', 'uninstall.bat', 'install.ps1', 'install.sh', 'uninstall.sh', 'package.json', 'src/patch.js', 'src/queue-runtime.js', 'src/activity.js', 'src/taskbar.ps1'];

function bat(args) {
  return [
    '@echo off',
    'setlocal',
    'chcp 65001 >nul',
    'title Claude Code Queue Mode',
    'set "SCRIPT=%~dp0src\\patch.js"',
    'if not exist "%SCRIPT%" (',
    '  echo Extract the whole archive first, then run this file from the extracted folder.',
    '  goto :end',
    ')',
    'where node >nul 2>nul',
    'if %errorlevel%==0 (',
    '  node "%SCRIPT%" ' + args,
    '  goto :end',
    ')',
    'rem No Node.js: run the patcher with the editor\'s own runtime.',
    'for %%E in ("%LOCALAPPDATA%\\Programs\\cursor\\Cursor.exe" "%ProgramFiles%\\cursor\\Cursor.exe" "%LOCALAPPDATA%\\Programs\\Microsoft VS Code\\Code.exe" "%ProgramFiles%\\Microsoft VS Code\\Code.exe" "%LOCALAPPDATA%\\Programs\\Windsurf\\Windsurf.exe") do (',
    '  if exist %%E (',
    '    set ELECTRON_RUN_AS_NODE=1',
    '    %%E "%SCRIPT%" ' + args,
    '    goto :end',
    '  )',
    ')',
    'echo Node.js was not found. Install it from https://nodejs.org and run this file again.',
    ':end',
    'echo.',
    'pause',
    ''
  ].join('\r\n');
}

function writeBats() {
  fs.writeFileSync(path.join(ROOT, 'install.bat'), bat('%*'));
  fs.writeFileSync(path.join(ROOT, 'uninstall.bat'), bat('--unpatch %*'));
  console.log('install.bat, uninstall.bat');
}

function buildDist() {
  const dist = path.join(ROOT, 'dist');
  fs.rmSync(dist, { recursive: true, force: true });
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), NAME + '-'));
  const top = path.join(stage, NAME);
  for (const f of DIST_FILES) {
    const to = path.join(top, f);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(ROOT, f), to);
    if (f.endsWith('.sh')) fs.chmodSync(to, 0o755);
  }
  fs.mkdirSync(dist);
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  cp.execFileSync(tar, ['-a', '-c', '-f', path.join(dist, NAME + '.zip'), NAME], { cwd: stage, stdio: 'inherit' });
  cp.execFileSync(tar, ['-z', '-c', '-f', path.join(dist, NAME + '.tar.gz'), NAME], { cwd: stage, stdio: 'inherit' });
  fs.rmSync(stage, { recursive: true, force: true });
  for (const f of fs.readdirSync(dist)) console.log('dist/' + f, fs.statSync(path.join(dist, f)).size, 'bytes');
}

writeBats();
if (process.argv.includes('--dist')) buildDist();
