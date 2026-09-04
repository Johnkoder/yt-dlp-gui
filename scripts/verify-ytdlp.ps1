#Requires -Version 5.1
<#
.SYNOPSIS
  Verifies the yt-dlp binary bundled as an application resource.

.DESCRIPTION
  Checks that src-tauri/resources/bin/yt-dlp.exe exists and can be
  launched (prints its version). This mirrors what the Rust backend's
  resolve_ytdlp_path() expects during development.
#>
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$binary = Join-Path $repoRoot "src-tauri\resources\bin\yt-dlp.exe"

if (-not (Test-Path -LiteralPath $binary)) {
  Write-Error "yt-dlp binary not found at $binary"
  exit 1
}

$version = & $binary --version
if ($LASTEXITCODE -ne 0) {
  Write-Error "yt-dlp.exe failed to run (exit code $LASTEXITCODE)."
  exit 1
}

Write-Output "yt-dlp OK: version $version ($binary)"
