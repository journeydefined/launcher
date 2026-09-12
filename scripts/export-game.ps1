param([Parameter(Mandatory=$true)][string]$GameProject,[Parameter(Mandatory=$true)][string]$GodotExe,[Parameter(Mandatory=$true)][string]$TemplateDirectory,[Parameter(Mandatory=$true)][string]$Version)
$ErrorActionPreference='Stop'
if($Version -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'){throw 'Use a simple release version.'}
$repo=Split-Path $PSScriptRoot -Parent
$source=(Resolve-Path -LiteralPath $GameProject).Path
$templates=(Resolve-Path -LiteralPath $TemplateDirectory).Path
$engine=(Resolve-Path -LiteralPath $GodotExe).Path
$templateVersion=(Get-Content -LiteralPath (Join-Path $templates 'version.txt') -Raw).Trim()
$engineVersion=(& $engine --version | Out-String).Trim()
if(-not $engineVersion.StartsWith($templateVersion)){throw 'Godot and export template versions do not match.'}
$releaseTemplate=Join-Path $templates 'windows_release_x86_64.exe'
if(-not(Test-Path -LiteralPath $releaseTemplate)){throw 'Windows x64 release template is missing.'}
$work=Join-Path $repo "private\exports\$Version"
if(Test-Path -LiteralPath $work){throw 'Export workspace exists. Use a new version to preserve previous builds.'}
$copy=Join-Path $work 'source';$output=Join-Path $work 'windows'
New-Item -ItemType Directory -Force $copy,$output | Out-Null
$excluded=@('.godot','.git','tests','checkpoints','tools','export_templates','feature_profiles','script_templates','text_editor_themes','backups','exports','build','out','node_modules')
Get-ChildItem -LiteralPath $source -Force | Where-Object {$_.Name -notin $excluded -and -not $_.Name.StartsWith('.') -and ($_.PSIsContainer -or $_.Extension -notin '.log','.exe','.zip','.pck','.tpz','.md','.bak')} | ForEach-Object {Copy-Item -LiteralPath $_.FullName -Destination $copy -Recurse}
$project=Join-Path $copy 'project.godot'
(Get-Content -LiteralPath $project -Raw).Replace('Battle Generals - Battlefield Test','Warplex: After Earth') | Set-Content -LiteralPath $project
$menu=Join-Path $copy 'scripts\main_menu.gd'
if(Test-Path -LiteralPath $menu){(Get-Content -LiteralPath $menu -Raw).Replace('BATTLE GENERALS','WARPLEX: AFTER EARTH') | Set-Content -LiteralPath $menu}
$templatePath=$releaseTemplate.Replace('\','/')
@"
[preset.0]
name="Windows Desktop"
platform="Windows Desktop"
runnable=true
export_filter="all_resources"
include_filter=""
exclude_filter="tests/*,checkpoints/*,tools/*"
[preset.0.options]
binary_format/architecture="x86_64"
binary_format/embed_pck=false
custom_template/release="$templatePath"
application/modify_resources=false
"@ | Set-Content -LiteralPath (Join-Path $copy 'export_presets.cfg')
& $engine --headless --path $copy --editor --import --quit *> (Join-Path $work 'import.log')
if($LASTEXITCODE -ne 0){throw 'Godot import failed. Review import.log.'}
& $engine --headless --path $copy --export-release 'Windows Desktop' (Join-Path $output 'WarplexAE.exe') *> (Join-Path $work 'export.log')
if($LASTEXITCODE -ne 0){throw 'Godot export failed. Review export.log.'}
$tag=$templateVersion.Replace('.stable','-stable')
Invoke-WebRequest "https://raw.githubusercontent.com/godotengine/godot/$tag/LICENSE.txt" -OutFile (Join-Path $output 'GODOT-LICENSE.txt')
Invoke-WebRequest "https://raw.githubusercontent.com/godotengine/godot/$tag/COPYRIGHT.txt" -OutFile (Join-Path $output 'GODOT-COPYRIGHT.txt')
& (Join-Path $PSScriptRoot 'package-game.ps1') -GameFolder $output -Version $Version -Notes "Warplex: After Earth Windows tester preview $Version."
Write-Output 'Private release exported and packaged. Review/test it before activating it for testers.'
