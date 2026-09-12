param([string]$ServiceUrl,[string]$OwnerKeyFile)
$ErrorActionPreference='Stop'
$repo=Split-Path $PSScriptRoot -Parent
$nodeCommand=Get-Command node -ErrorAction SilentlyContinue
$nodePath=if($nodeCommand){$nodeCommand.Source}else{Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'}
if(-not(Test-Path -LiteralPath $nodePath)){throw 'Install Node.js 24 LTS from nodejs.org to use owner tools.'}
if(-not $ServiceUrl){$ServiceUrl=Read-Host 'HTTPS address of the deployed release service'}
if(-not $OwnerKeyFile){$OwnerKeyFile=Read-Host 'Path to your private owner-key file'}
$common=@('--url',$ServiceUrl,'--key-file',$OwnerKeyFile)
while($true){
 Write-Host "`nWARPLEX AE — OWNER DESK"
 Write-Host '1  Invite a tester'
 Write-Host '2  List testers'
 Write-Host '3  Revoke tester access'
 Write-Host '4  Upload and verify a game release'
 Write-Host '5  Activate a release / roll back'
 Write-Host '6  List releases'
 Write-Host '7  View recent owner actions'
 Write-Host '8  Initialize Cloudflare database (first setup)'
 Write-Host '0  Exit'
 $choice=Read-Host 'Choose'
 switch($choice){
  '1' {$label=Read-Host 'Tester name or label';$days=Read-Host 'Access days (1 to 90)';$destination=Read-Host 'Save private invitation JSON to'; & $nodePath "$repo\service\owner.mjs" invite @common --name $label --days $days --out $destination}
  '2' {& $nodePath "$repo\service\owner.mjs" testers @common}
  '3' {$tester=Read-Host 'Tester ID from the list'; & $nodePath "$repo\service\owner.mjs" revoke @common --id $tester}
  '4' {$manifest=Read-Host 'Path to the packaged release JSON'; & $nodePath "$repo\service\owner.mjs" publish @common --manifest $manifest; if($LASTEXITCODE -eq 0){Write-Host 'Release verified and staged. Choose 5 to make it available to testers.'}}
  '5' {$version=Read-Host 'Verified version to activate'; & $nodePath "$repo\service\owner.mjs" activate @common --version $version}
  '6' {& $nodePath "$repo\service\owner.mjs" releases @common}
  '7' {& $nodePath "$repo\service\owner.mjs" audit @common}
  '8' {& $nodePath "$repo\service\owner.mjs" bootstrap @common}
  '0' {return}
 }
}
