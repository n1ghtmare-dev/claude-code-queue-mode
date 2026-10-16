# Claude Code Queue Mode — installer for Windows (PowerShell).
#
#   irm https://raw.githubusercontent.com/n1ghtmare-dev/claude-code-queue-mode/main/install.ps1 | iex
#
# Uninstall:
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/n1ghtmare-dev/claude-code-queue-mode/main/install.ps1))) -Uninstall
param(
  [switch]$Uninstall,
  [switch]$Status
)

$ErrorActionPreference = 'Stop'
$archive = 'https://github.com/n1ghtmare-dev/claude-code-queue-mode/releases/latest/download/claude-code-queue-mode.zip'

$patcherArgs = @()
if ($Uninstall) { $patcherArgs += '--unpatch' }
if ($Status) { $patcherArgs += '--status' }

function Invoke-Patcher([string]$script) {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if ($node) {
    & $node.Source $script @patcherArgs
    return
  }
  # No Node.js: run the patcher with the editor's own runtime.
  $editors = @(
    "$env:LOCALAPPDATA\Programs\cursor\Cursor.exe",
    "$env:ProgramFiles\cursor\Cursor.exe",
    "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe",
    "$env:ProgramFiles\Microsoft VS Code\Code.exe",
    "$env:LOCALAPPDATA\Programs\Windsurf\Windsurf.exe"
  )
  $editor = $editors | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $editor) { throw 'Node.js was not found. Install it from https://nodejs.org and run this again.' }
  $env:ELECTRON_RUN_AS_NODE = '1'
  try { & $editor $script @patcherArgs | Out-Host }
  finally { Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue }
}

$local = if ($PSScriptRoot) { Join-Path $PSScriptRoot 'src\patch.js' } else { $null }
if ($local -and (Test-Path $local)) {
  Invoke-Patcher $local
  return
}

[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('claude-code-queue-mode-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  $zip = Join-Path $tmp 'claude-code-queue-mode.zip'
  Write-Host "Downloading $archive"
  $ProgressPreference = 'SilentlyContinue'
  Invoke-WebRequest -Uri $archive -OutFile $zip -UseBasicParsing
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  Invoke-Patcher (Join-Path $tmp 'claude-code-queue-mode\src\patch.js')
}
finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
