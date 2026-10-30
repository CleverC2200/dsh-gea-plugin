param([Parameter(Mandatory=$true)][string]$CertificatePath,[switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
$certificate = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($CertificatePath)
$store = New-Object System.Security.Cryptography.X509Certificates.X509Store('Root','CurrentUser')
try {
    $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
    $found = $store.Certificates.Find([System.Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint,$certificate.Thumbprint,$false)
    if ($CheckOnly) { if ($found.Count -eq 0) { exit 3 }; exit 0 }
    if ($found.Count -eq 0) {
        Write-Output '[GEA-CERT] import-root-begin'
        & (Join-Path $env:SystemRoot 'System32\certutil.exe') -user -f -addstore Root $CertificatePath | Out-Null
        Write-Output '[GEA-CERT] import-root-end'
        if ($LASTEXITCODE -ne 0) { throw 'WINDOWS_CERTIFICATE_IMPORT_FAILED' }
    }
    $found = $store.Certificates.Find([System.Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint,$certificate.Thumbprint,$false)
    if ($found.Count -eq 0) { throw 'WINDOWS_CERTIFICATE_IMPORT_FAILED' }
} finally {
    $store.Close()
}
