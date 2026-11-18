param([string]$Installer,[string]$WorkDirectory,[string]$ExpectedVersion,[string]$CertificatePath)
$ErrorActionPreference = 'Stop'
foreach ($module in @('Security','Utility','Management')) {
    Import-Module "$PSHOME/Modules/Microsoft.PowerShell.$module/Microsoft.PowerShell.$module.psd1" -ErrorAction Stop
}
$installation = Join-Path $WorkDirectory 'installed'
$executable = Join-Path $installation 'GEA Desktop.exe'
$userRoot = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'dsh-gea-desktop'
$marker = Join-Path $userRoot 'signed-upgrade-preservation.json'
[IO.Directory]::CreateDirectory($userRoot) | Out-Null
function Stop-InstalledApplication {
    Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $executable } | ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
}
function Install-Client([string]$Installer) {
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $Installer
    $info.Arguments = '/S /D=' + $installation
    $info.UseShellExecute = $false
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $info
    if (!$process.Start()) { throw 'INSTALLER_START_FAILED' }
    if (!$process.WaitForExit(180000)) {
        & "$env:SystemRoot\System32\taskkill.exe" /PID $process.Id /T /F | Out-Null
        throw 'INSTALLER_TIMEOUT'
    }
    if ($process.ExitCode -ne 0) { throw ('INSTALLER_EXIT_' + $process.ExitCode) }
    Start-Sleep -Seconds 2
    Stop-InstalledApplication
    if (!(Test-Path -LiteralPath $executable)) { throw 'INSTALLED_EXECUTABLE_MISSING' }
}
function Installed-Version {
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $executable
    $info.Arguments = '--expose-internals -p "require(process.argv[1]).version" "' + (Join-Path $installation 'resources/app.asar/package.json') + '"'
    $info.UseShellExecute = $false
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.EnvironmentVariables['ELECTRON_RUN_AS_NODE'] = '1'
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $info
    if (!$process.Start()) { throw 'INSTALLED_MANIFEST_PROCESS_FAILED' }
    $output = $process.StandardOutput.ReadToEndAsync()
    $errors = $process.StandardError.ReadToEndAsync()
    if (!$process.WaitForExit(30000)) { $process.Kill(); throw 'INSTALLED_MANIFEST_TIMEOUT' }
    $value = $output.Result
    if ($process.ExitCode -ne 0) { throw ('INSTALLED_MANIFEST_READ_FAILED: ' + $value + $errors.Result) }
    return $value.Trim()
}
try {
    Install-Client $Installer
    if ((Installed-Version) -ne $ExpectedVersion) { throw 'INSTALLED_VERSION_MISMATCH' }
    $signature = Get-AuthenticodeSignature -LiteralPath $executable
    $certificate = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($CertificatePath)
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Thumbprint -ne $certificate.Thumbprint) { throw 'INSTALLED_SIGNATURE_INVALID' }
} finally { Stop-InstalledApplication }
