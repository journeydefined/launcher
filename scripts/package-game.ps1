param([Parameter(Mandatory=$true)][string]$GameFolder,[Parameter(Mandatory=$true)][string]$Version,[string]$Executable='WarplexAE.exe',[string]$Notes='Private development preview. Please report issues to the game owner.')
$ErrorActionPreference='Stop'
$repo=Split-Path $PSScriptRoot -Parent
$destination=Join-Path $repo 'private\releases'
New-Item -ItemType Directory -Force $destination | Out-Null
if ($Version -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') { throw 'Use a simple version identifier.' }
$game=(Resolve-Path -LiteralPath $GameFolder).Path
if (-not (Test-Path -LiteralPath (Join-Path $game $Executable) -PathType Leaf)) { throw 'Game executable does not exist.' }
$archive=Join-Path $destination "warplex-ae-$Version.zip"
if (Test-Path -LiteralPath $archive) { throw 'Release already exists. Use a new version.' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($game,$archive,[System.IO.Compression.CompressionLevel]::Optimal,$false)
$bytes=(Get-ChildItem -LiteralPath $game -File -Recurse | Measure-Object Length -Sum).Sum
$manifest=[ordered]@{gameId='warplex-ae';version=$Version;archive=[IO.Path]::GetFileName($archive);sha256=(Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant();size=(Get-Item -LiteralPath $archive).Length;unpackedBytes=[long]$bytes;executable=$Executable;notes=$Notes}
$manifestPath=Join-Path $destination "warplex-ae-$Version.json"
$manifest | ConvertTo-Json | Set-Content -LiteralPath $manifestPath -Encoding UTF8
Write-Output "Created private package: $archive"
Write-Output "Manifest: $manifestPath"
