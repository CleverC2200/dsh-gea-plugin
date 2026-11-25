param([switch]$Install)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$output = Join-Path $env:RUNNER_TEMP 'gea-certum'
$desktop = 'C:\Program Files\Certum\SimplySign Desktop\SimplySignDesktop.exe'
New-Item -ItemType Directory -Force -Path $output | Out-Null

if ($Install) {
    $msi = Join-Path $output 'simplysign.msi'
    Invoke-WebRequest -Uri 'https://files.certum.eu/software/SimplySignDesktop/Windows/9.4.4.92/SimplySignDesktop-9.4.4.92-64-bit-en.msi' -OutFile $msi -TimeoutSec 120
    if ((Get-FileHash -LiteralPath $msi -Algorithm SHA256).Hash -ne '8ec420fc27798b86078b7bd02fe7152097e1b3005bab51820eaca8e57df84da3' -or
        (Get-AuthenticodeSignature -LiteralPath $msi).Status -ne 'Valid') {
        throw 'WINDOWS_CERTUM_MSI_SIGNATURE_INVALID'
    }
    $process = Start-Process -FilePath 'msiexec.exe' -ArgumentList "/i `"$msi`" /qn /norestart" -PassThru
    if (!$process.WaitForExit(180000) -or $process.ExitCode -notin 0, 3010) {
        throw 'WINDOWS_CERTUM_INSTALL_FAILED'
    }
    if (!(Test-Path -LiteralPath $desktop -PathType Leaf)) { throw 'WINDOWS_CERTUM_DESKTOP_MISSING' }
    $auth = Join-Path $output 'auth.mjs'
    Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/jay0lee/certum-cloud-code-sign/a3324503499c49090869856eeeecfe95fb613d87/scripts/auth.mjs' -OutFile $auth -TimeoutSec 30
    if ((Get-FileHash -LiteralPath $auth -Algorithm SHA256).Hash -ne '1c33b1bfe549f74c497693a047ef1472e8229a27970183174a9276a0540d2934') {
        throw 'WINDOWS_CERTUM_AUTH_SCRIPT_CHANGED'
    }
    "GEA_CERTUM_AUTH_SCRIPT=$auth" | Add-Content -LiteralPath $env:GITHUB_ENV
    "CERTUM_APP_PATH=$desktop" | Add-Content -LiteralPath $env:GITHUB_ENV
    exit 0
}

$expected = $env:GEA_WINDOWS_STORE_CERT_SHA1
if ($expected -notmatch '\A[0-9a-fA-F]{40}\z') { throw 'WINDOWS_CERTUM_THUMBPRINT_REQUIRED' }
$deadline = [DateTime]::UtcNow.AddSeconds(60)
do {
    $certificate = Get-Item -LiteralPath "Cert:\CurrentUser\My\$expected" -ErrorAction SilentlyContinue
    if ($certificate -and $certificate.HasPrivateKey) { break }
    Start-Sleep -Seconds 2
} while ([DateTime]::UtcNow -lt $deadline)
if (!$certificate -or !$certificate.HasPrivateKey) { throw 'WINDOWS_CERTUM_CERTIFICATE_UNAVAILABLE' }
$certFile = Join-Path $output 'codesign.cer'
[IO.File]::WriteAllBytes($certFile, $certificate.RawData)
$signTool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" -File |
    Sort-Object FullName -Descending | Select-Object -First 1
if (!$signTool) { throw 'WINDOWS_CERTUM_SIGNTOOL_UNAVAILABLE' }
"GEA_WINDOWS_STORE_CER_FILE=$certFile" | Add-Content -LiteralPath $env:GITHUB_ENV
"GEA_WINDOWS_SIGNTOOL=$($signTool.FullName)" | Add-Content -LiteralPath $env:GITHUB_ENV

$sample = Join-Path $output 'sample.exe'
Copy-Item -LiteralPath "$env:SystemRoot\System32\whoami.exe" -Destination $sample
$process = Start-Process -FilePath $signTool.FullName -ArgumentList (
    "sign /s My /sha1 $expected /fd SHA256 /tr http://time.certum.pl /td SHA256 `"$sample`""
) -PassThru -NoNewWindow
if (!$process.WaitForExit(90000)) {
    $process.Kill()
    throw 'WINDOWS_CERTUM_SIGNING_TIMED_OUT'
}
if ($process.ExitCode -ne 0) { throw 'WINDOWS_CERTUM_SAMPLE_SIGN_FAILED' }
& $signTool.FullName verify /pa /tw $sample
if ($LASTEXITCODE -ne 0) { throw 'WINDOWS_CERTUM_SAMPLE_VERIFY_FAILED' }
$signature = Get-AuthenticodeSignature -LiteralPath $sample
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Thumbprint -ne $expected -or !$signature.TimeStamperCertificate) {
    throw 'WINDOWS_CERTUM_SAMPLE_IDENTITY_INVALID'
}
@{
    thumbprint = $signature.SignerCertificate.Thumbprint
    subject = $signature.SignerCertificate.Subject
    issuer = $signature.SignerCertificate.Issuer
    timestamped = $true
    signature = 'Valid'
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output 'certificate-proof.json')
