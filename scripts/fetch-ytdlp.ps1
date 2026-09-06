#Requires -Version 5.1
<#
.SYNOPSIS
  Fetches the pinned yt-dlp executable from the official upstream release.

.DESCRIPTION
  Reads scripts/ytdlp-version.json (version + SHA-256), downloads ONLY
  from https://github.com/yt-dlp/yt-dlp/releases/download/<version>/,
  verifies the SHA-256 hash, and writes
  src-tauri/resources/bin/yt-dlp.exe only after verification succeeds.

  No administrator privileges required. PowerShell 5.1 compatible.
#>
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $PSScriptRoot "ytdlp-version.json"
$targetDir = Join-Path $repoRoot "src-tauri\resources\bin"
$targetPath = Join-Path $targetDir "yt-dlp.exe"

if (-not (Test-Path -LiteralPath $configPath)) {
    Write-Error "Version config not found: $configPath"
    exit 1
}

$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$version = $config.version
$expectedHash = $config.sha256
$asset = $config.asset
$releaseBase = $config.releaseBase

foreach ($field in @($version, $expectedHash, $asset, $releaseBase)) {
    if ([string]::IsNullOrWhiteSpace($field)) {
        Write-Error "Invalid version config: missing version/sha256/asset/releaseBase."
        exit 1
    }
}

# Strict allow-list: official yt-dlp GitHub releases only.
if ($releaseBase -ne "https://github.com/yt-dlp/yt-dlp/releases/download") {
    Write-Error "Refusing unexpected release base: $releaseBase"
    exit 1
}

if ($asset -notmatch '^yt-dlp\.exe$') {
    Write-Error "Refusing unexpected asset name: $asset"
    exit 1
}

if ($version -notmatch '^\d{4}\.\d{2}\.\d{2}$') {
    Write-Error "Refusing unexpected version format: $version"
    exit 1
}

$url = "$releaseBase/$version/$asset"
Write-Output "Downloading yt-dlp $version from official release..."
Write-Output "  $url"

New-Item -ItemType Directory -Force -Path $targetDir | Out-Null

$tempPath = Join-Path ([System.IO.Path]::GetTempPath()) ("ytdlp-gui-" + [System.Guid]::NewGuid().ToString() + ".exe")
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $url -OutFile $tempPath -UseBasicParsing

    $actualHash = (Get-FileHash -LiteralPath $tempPath -Algorithm SHA256).Hash
    if ($actualHash -ne $expectedHash.ToUpperInvariant()) {
        Write-Error ("SHA-256 mismatch! Expected {0} but got {1}. File rejected." -f $expectedHash, $actualHash)
        exit 1
    }

    Copy-Item -LiteralPath $tempPath -Destination $targetPath -Force
    Write-Output "Verified SHA-256 and installed:"
    Write-Output "  $targetPath"
}
finally {
    if (Test-Path -LiteralPath $tempPath) {
        Remove-Item -LiteralPath $tempPath -Force
    }
}
