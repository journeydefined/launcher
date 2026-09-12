param()
$ErrorActionPreference='Stop'
$repo=Split-Path $PSScriptRoot -Parent
$stage=Join-Path $repo 'out\tester-bundle'
New-Item -ItemType Directory -Force $stage | Out-Null
Copy-Item -LiteralPath (Join-Path $repo 'out\JourneyLauncher.exe'),(Join-Path $repo 'out\JourneyLauncher.exe.config') -Destination $stage
@"
WARPLEX AE — TESTER LAUNCHER

1. Extract this ZIP to a folder on your Windows PC.
2. Open JourneyLauncher.exe.
3. Open Settings, choose Import tester invitation, and select the private invitation JSON supplied by the game owner.
4. Review the server address, save settings, and choose Install.
5. Choose Play. The launcher checks for updates each time it opens.

Your invitation grants access until it expires or the owner revokes it. Keep the invitation private. Windows x64 and .NET Framework 4.8 are required. This preview is unsigned; Windows may show a publisher warning. Contact the game owner if access is denied.

No game files or access credentials are included in this launcher ZIP.
"@ | Set-Content -LiteralPath (Join-Path $stage 'START-HERE.txt')
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive=Join-Path $repo 'out\JourneyLauncher-0.2-preview.zip'
if(Test-Path -LiteralPath $archive){throw 'Launcher bundle already exists. Preserve or rename it before packaging again.'}
[IO.Compression.ZipFile]::CreateFromDirectory($stage,$archive)
Write-Output "Tester launcher bundle: $archive"
