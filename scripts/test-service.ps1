$ErrorActionPreference='Stop'
$repo=Split-Path $PSScriptRoot -Parent
$certDir=Join-Path $repo 'private\test-tls'
New-Item -ItemType Directory -Force $certDir | Out-Null
$rsa=[Security.Cryptography.RSA]::Create(2048)
$request=[Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=localhost',$rsa,[Security.Cryptography.HashAlgorithmName]::SHA256,[Security.Cryptography.RSASignaturePadding]::Pkcs1)
$san=[Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
$san.AddDnsName('localhost');$san.AddIpAddress([Net.IPAddress]::Loopback)
$request.CertificateExtensions.Add($san.Build())
$request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false,$false,0,$true))
$cert=$request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-5),[DateTimeOffset]::UtcNow.AddDays(1))
try {
 [IO.File]::WriteAllText((Join-Path $certDir 'cert.pem'),$cert.ExportCertificatePem())
 [IO.File]::WriteAllText((Join-Path $certDir 'key.pem'),$rsa.ExportPkcs8PrivateKeyPem())
 $env:TEST_TLS_CERT=Join-Path $certDir 'cert.pem';$env:TEST_TLS_KEY=Join-Path $certDir 'key.pem'
 node --test "$repo\service\tests\service.test.mjs"
 if($LASTEXITCODE -ne 0){throw 'Private service tests failed.'}
} finally {$cert.Dispose();$rsa.Dispose();Remove-Item Env:TEST_TLS_CERT,Env:TEST_TLS_KEY -ErrorAction SilentlyContinue}
