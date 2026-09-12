param([switch]$Test)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$framework = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$out = Join-Path $repo 'out'
New-Item -ItemType Directory -Force $out | Out-Null
$refs = @('System.dll','System.Core.dll','System.Xaml.dll','System.Web.Extensions.dll','System.Security.dll','System.Net.Http.dll','System.IO.Compression.dll','System.IO.Compression.FileSystem.dll','System.Windows.Forms.dll','System.Drawing.dll') | ForEach-Object { '/reference:' + (Join-Path $framework $_) }
$refs += @('WindowsBase.dll','PresentationCore.dll','PresentationFramework.dll') | ForEach-Object { '/reference:' + (Join-Path $framework ('WPF\' + $_)) }
& (Join-Path $framework 'csc.exe') /nologo /target:winexe /platform:x64 /optimize+ "/out:$out\JourneyLauncher.exe" "/resource:$repo\src\MainWindow.xaml,MainWindow.xaml" "/resource:$repo\assets\warplex-ae.png,warplex-ae.png" @refs "$repo\src\Installer.cs" "$repo\src\Program.cs" "$repo\tests\Tests.cs"
if ($LASTEXITCODE -ne 0) { throw 'Launcher compilation failed.' }
Copy-Item -LiteralPath (Join-Path $repo 'src\JourneyLauncher.exe.config') -Destination $out
if ($Test) {
 $process = Start-Process -FilePath "$out\JourneyLauncher.exe" -ArgumentList '--self-test' -PassThru -Wait -WindowStyle Hidden
 Get-Content "$out\test-results.txt"
 if ($process.ExitCode -ne 0) { throw 'Launcher tests failed.' }
}
Write-Output "Built $out\JourneyLauncher.exe"
