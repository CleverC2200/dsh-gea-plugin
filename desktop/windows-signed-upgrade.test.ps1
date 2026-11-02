param([string]$OldInstaller,[string]$NewInstaller,[string]$WorkDirectory,[string]$NewVersion,[string]$CertificatePath)
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
try {
    Install-Client $OldInstaller
    if ((Get-Item -LiteralPath $executable).VersionInfo.ProductVersion -ne '0.2.0-rc.2.20261102.2') { throw 'BASELINE_VERSION_MISMATCH' }
    $state = '{"session":"existing-session","configuration":"preserve","draft":"existing-draft"}'
    [IO.File]::WriteAllText($marker,$state,[Text.UTF8Encoding]::new($false))
    Install-Client $NewInstaller
    if ((Get-Item -LiteralPath $executable).VersionInfo.ProductVersion -ne $NewVersion) { throw 'UPGRADE_VERSION_MISMATCH' }
    if ([IO.File]::ReadAllText($marker) -ne $state) { throw 'USER_FILES_CHANGED' }
    $signature = Get-AuthenticodeSignature -LiteralPath $executable
    $certificate = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($CertificatePath)
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Thumbprint -ne $certificate.Thumbprint) { throw 'INSTALLED_SIGNATURE_INVALID' }
    [IO.File]::WriteAllText((Join-Path $WorkDirectory 'overwrite.json'),(@{status='passed';from='0.2.0-rc.2.20261102.2';to=$NewVersion;installedSignature='Valid';existingUserFilesPreserved=$true;employeeDeviceAcceptance=$false} | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
} finally {
    Stop-InstalledApplication
}
