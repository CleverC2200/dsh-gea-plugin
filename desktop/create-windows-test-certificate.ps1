param(
  [string]$OutputDirectory = (Join-Path $PWD 'windows-test-signing'),
  [string]$Publisher = 'GEA Desktop Test'
)

$ErrorActionPreference = 'Stop'
$subject = "CN=$Publisher"
$output = [IO.Path]::GetFullPath($OutputDirectory)
$pfxPath = Join-Path $output 'gea-desktop-test.pfx'
$cerPath = Join-Path $output 'gea-desktop-test.cer'

New-Item -ItemType Directory -Force -Path $output | Out-Null
$password = Read-Host '为测试 PFX 设置密码' -AsSecureString

$certificate = New-SelfSignedCertificate `
  -Type Custom `
  -Subject $subject `
  -FriendlyName 'GEA Desktop Windows Test Signing' `
  -KeyAlgorithm RSA `
  -KeyLength 2048 `
  -HashAlgorithm SHA256 `
  -KeyUsage DigitalSignature `
  -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3') `
  -CertStoreLocation 'Cert:\CurrentUser\My' `
  -NotAfter (Get-Date).AddYears(2)

Export-PfxCertificate -Cert $certificate -FilePath $pfxPath -Password $password -Force | Out-Null
Export-Certificate -Cert $certificate -FilePath $cerPath -Type CERT -Force | Out-Null
Import-Certificate -FilePath $cerPath -CertStoreLocation 'Cert:\CurrentUser\TrustedPeople' | Out-Null

Write-Host ''
Write-Host '测试证书已生成并加入当前用户信任区。' -ForegroundColor Green
Write-Host "PFX: $pfxPath"
Write-Host "Publisher: $subject"
Write-Host ''
Write-Host '构建前在同一个 PowerShell 窗口执行：'
Write-Host "`$env:WIN_CSC_LINK='$pfxPath'"
Write-Host "`$env:WIN_CSC_KEY_PASSWORD='(刚才设置的密码)'"
Write-Host "`$env:GEA_WIN_REQUIRE_SIGNING='1'"
Write-Host "`$env:GEA_MSIX_PUBLISHER='$subject'"
Write-Host ''
Write-Host '该证书仅供内部测试，不能用于正式发布。'
