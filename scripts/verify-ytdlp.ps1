#Requires -Version 5.1
<#
.SYNOPSIS
  Verifies the local yt-dlp resource binary without modifying it.

.DESCRIPTION
  Checks that src-tauri/resources/bin/yt-dlp.exe:
  1. exists
  2. matches the pinned SHA-256 from scripts/ytdlp-version.json
  3. launches and reports the pinned version

  Read-only: never downloads, installs, or modifies anything.
#>
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $PSScriptRoot "ytdlp-version.json"
$binary = Join-Path $repoRoot "src-tauri\resources\bin\yt-dlp.exe"

$failed = $false

function Fail([string]$message) {
    Write-Output "FAIL: $message"
    $script:failed = $true
}

if (-not (Test-Path -LiteralPath $configPath)) {
    Write-Error "Version config not found: $configPath"
    exit 1
}
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json

if (-not (Test-Path -LiteralPath $binary)) {
    Fail "yt-dlp.exe not found at $binary (run: npm run setup:ytdlp)"
} else {
    $actualHash = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash
    if ($actualHash -ne $config.sha256.ToUpperInvariant()) {
        Fail ("SHA-256 mismatch. Expected {0} but got {1}." -f $config.sha256, $actualHash)
    } else {
        Write-Output "ok: SHA-256 matches pinned hash."
    }

    try {
        $version = (& $binary --version 2>&1 | Select-Object -First 1).Trim()
    } catch {
        Fail "yt-dlp.exe failed to launch: $_"
        $version = ""
    }
    if ($version -ne "") {
        if ($version -ne $config.version) {
            Fail ("version mismatch. Expected {0} but got {1}." -f $config.version, $version)
        } else {
            Write-Output "ok: version $version matches pinned version."
        }
    }
}

if ($failed) {
    exit 1
}
Write-Output "yt-dlp resource verified."
