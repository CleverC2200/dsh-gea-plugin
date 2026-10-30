param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$root = Join-Path $PSScriptRoot 'build'
$work = Join-Path $env:TEMP ('gea-certificate-test-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($work) | Out-Null
[IO.Directory]::CreateDirectory($OutputDirectory) | Out-Null
$certificate = $null
try {
    $certificate = New-SelfSignedCertificate -Type CodeSigningCert -Subject ('CN=GEA Native Test ' + [Guid]::NewGuid().ToString('N') + ', O=GEA Test, C=CN') -CertStoreLocation 'Cert:\CurrentUser\My' -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 -KeyExportPolicy Exportable -NotAfter (Get-Date).AddDays(1)
    $cer = Join-Path $work 'codesign.cer'
    $pfx = Join-Path $work 'codesign.pfx'
    $passwordFile = Join-Path $work 'password.txt'
    $password = [Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N')
    Export-Certificate -Cert $certificate -FilePath $cer | Out-Null
    Export-PfxCertificate -Cert $certificate -FilePath $pfx -Password (ConvertTo-SecureString $password -AsPlainText -Force) | Out-Null
    [IO.File]::WriteAllText($passwordFile,$password,[Text.UTF8Encoding]::new($false))
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $root 'install-certificate.ps1') -CertificatePath $cer -CheckOnly
    if ($LASTEXITCODE -ne 3) { throw 'EXPECTED_UNTRUSTED_CERTIFICATE' }
    foreach ($version in @('1','2')) {
        $target = Join-Path $work ('update-' + $version + '.ps1')
        [IO.File]::WriteAllText($target,('Write-Output "version ' + $version + '"'),[Text.UTF8Encoding]::new($false))
        & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $root 'sign-windows.ps1') -TargetPath $target -PfxFile $pfx -PasswordFile $passwordFile -CertificatePath $cer
        if ($LASTEXITCODE -ne 0) { throw 'SIGNING_FAILED' }
        $signature = Get-AuthenticodeSignature -LiteralPath $target
        if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Thumbprint -ne $certificate.Thumbprint -or $null -eq $signature.TimeStamperCertificate) { throw 'UPDATE_SIGNATURE_INVALID' }
    }
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $root 'install-certificate.ps1') -CertificatePath $cer -CheckOnly
    if ($LASTEXITCODE -ne 0) { throw 'EXPECTED_TRUSTED_CERTIFICATE' }
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $root 'install-certificate.ps1') -CertificatePath $cer
    if ($LASTEXITCODE -ne 0) { throw 'IDEMPOTENT_IMPORT_FAILED' }
    $matches = @(Get-ChildItem 'Cert:\CurrentUser\Root' | Where-Object { $_.Thumbprint -eq $certificate.Thumbprint })
    if ($matches.Count -ne 1) { throw 'DUPLICATE_TRUSTED_CERTIFICATE' }
    [IO.File]::WriteAllText((Join-Path $OutputDirectory 'result.json'),(@{status='passed';windows=$env:OS;codeSigning=$true;timestamped=$true;versions=2;idempotentImport=$true;productionCertificateUsed=$false;actualNativeUpdateAcceptance=$false} | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
} finally {
    if ($null -ne $certificate) {
        Remove-Item -LiteralPath ('Cert:\CurrentUser\Root\' + $certificate.Thumbprint) -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath ('Cert:\CurrentUser\My\' + $certificate.Thumbprint) -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $work -Recurse -Force
}
