param(
    [Parameter(Mandatory=$true)][string]$TargetPath,
    [Parameter(Mandatory=$true)][string]$PfxFile,
    [Parameter(Mandatory=$true)][string]$PasswordFile,
    [Parameter(Mandatory=$true)][string]$CertificatePath
)
$ErrorActionPreference = 'Stop'
foreach ($module in @('Security','Utility','Management')) {
    Import-Module "$PSHOME/Modules/Microsoft.PowerShell.$module/Microsoft.PowerShell.$module.psd1" -ErrorAction Stop
}
$public = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($CertificatePath)
$password = [IO.File]::ReadAllText($PasswordFile).TrimEnd("`r","`n")
$certificate = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2
try {
    Write-Output '[GEA-CERT] load-pfx-begin'
    try { $certificate.Import($PfxFile,$password,[System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::DefaultKeySet) }
    catch { throw 'WINDOWS_PFX_IMPORT_FAILED' }
    if (!$certificate.HasPrivateKey -or [Convert]::ToBase64String($certificate.RawData) -ne [Convert]::ToBase64String($public.RawData)) { throw 'WINDOWS_SIGNING_CERTIFICATE_MISMATCH' }
    Write-Output '[GEA-CERT] trust-root-begin'
    & (Join-Path $PSScriptRoot 'install-certificate.ps1') -CertificatePath $CertificatePath -StoreLocation LocalMachine
    Write-Output '[GEA-CERT] trust-root-end'
    $existing = Get-AuthenticodeSignature -LiteralPath $TargetPath
    if ($existing.Status -eq 'Valid' -and $null -ne $existing.TimeStamperCertificate) { return }
    Write-Output '[GEA-CERT] timestamp-sign-begin'
    $result = Set-AuthenticodeSignature -LiteralPath $TargetPath -Certificate $certificate -HashAlgorithm SHA256 -IncludeChain Signer -TimestampServer 'http://timestamp.digicert.com'
    Write-Output '[GEA-CERT] timestamp-sign-end'
    if ($result.Status -ne 'Valid' -or $null -eq $result.TimeStamperCertificate -or $result.SignerCertificate.Thumbprint -ne $public.Thumbprint) { throw 'WINDOWS_SIGNING_OR_TIMESTAMP_FAILED' }
} finally {
    $certificate.Dispose()
    $password = $null
}
