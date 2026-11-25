param(
    [Parameter(Mandatory = $true)][string]$Target,
    [Parameter(Mandatory = $true)][string]$Executable,
    [string]$Backup,
    [int]$Owner,
    [string]$Ready
)

$ErrorActionPreference = 'Stop'

function Test-ExistingInstallation([string]$Directory) {
    if (![IO.Directory]::Exists($Directory)) { return $false }
    if ([IO.File]::GetAttributes($Directory) -band [IO.FileAttributes]::ReparsePoint) {
        return $false
    }
    $application = [IO.Path]::Combine($Directory, $Executable)
    return [IO.File]::Exists($application) -and
        !([IO.File]::GetAttributes($application) -band [IO.FileAttributes]::ReparsePoint)
}

function Test-BackupName([string]$Path) {
    $prefix = "$Target.old-"
    if (!$Path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { return $false }
    $id = [Guid]::Empty
    return [Guid]::TryParseExact($Path.Substring($prefix.Length), 'B', [ref]$id)
}

if ($Owner) {
    if (!(Test-BackupName $Backup) -or !(Test-ExistingInstallation $Target)) { exit 2 }
    $installer = [Diagnostics.Process]::GetProcessById($Owner)
    try {
        $null = $installer.Handle
        [IO.File]::WriteAllText($Ready, '')
        $installer.WaitForExit()
    } finally {
        $installer.Dispose()
    }
} else {
    if (Test-Path -LiteralPath $Target) { exit 0 }
    $parent = [IO.Path]::GetDirectoryName($Target)
    if (![IO.Directory]::Exists($parent)) { exit 0 }
    $candidates = @([IO.Directory]::EnumerateDirectories($parent) | Where-Object {
        (Test-BackupName $_) -and (Test-ExistingInstallation $_)
    })
    if ($candidates.Count -ne 1) { exit 0 }
    $Backup = $candidates[0]
}

if (!(Test-Path -LiteralPath $Target) -and (Test-ExistingInstallation $Backup)) {
    try {
        [IO.Directory]::Move($Backup, $Target)
    } catch [IO.IOException] {
        if (!(Test-ExistingInstallation $Target)) { throw }
    }
}
