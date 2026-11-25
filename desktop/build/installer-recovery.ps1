param(
    [Parameter(Mandatory = $true)][string]$Target,
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string]$Backup,
    [int]$Owner,
    [string]$Ready
)

$ErrorActionPreference = 'Stop'

function Test-PhysicalPath([string]$Path) {
    for ($item = $Path; $item; $item = [IO.Path]::GetDirectoryName($item)) {
        try {
            if ([IO.File]::GetAttributes($item) -band [IO.FileAttributes]::ReparsePoint) {
                return $false
            }
        } catch [IO.FileNotFoundException], [IO.DirectoryNotFoundException] {
        }
    }
    return $true
}

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

if (!(Test-BackupName $Backup) -or !(Test-PhysicalPath $Target)) { exit 2 }

if ($Owner) {
    if (!(Test-ExistingInstallation $Target)) { exit 2 }
    $installer = [Diagnostics.Process]::GetProcessById($Owner)
    try {
        $null = $installer.Handle
        [IO.File]::WriteAllText($Ready, '')
        $installer.WaitForExit()
    } finally {
        $installer.Dispose()
    }
} else {
    if (!(Test-ExistingInstallation $Backup)) { exit 0 }
    if ([IO.Directory]::Exists($Target)) {
        [IO.Directory]::Delete($Target, $false)
    }
}

if (!(Test-Path -LiteralPath $Target) -and (Test-PhysicalPath $Target) -and
    (Test-ExistingInstallation $Backup)) {
    try {
        [IO.Directory]::Move($Backup, $Target)
    } catch [IO.IOException] {
        if (!(Test-ExistingInstallation $Target)) { throw }
        exit 0
    }
    $staged = "$Target.new-" + $Backup.Substring("$Target.old-".Length)
    if ([IO.Directory]::Exists($staged) -and (Test-PhysicalPath $staged)) {
        try {
            [IO.Directory]::Delete($staged, $true)
        } catch [IO.IOException], [UnauthorizedAccessException] {
            Write-Warning "The interrupted installation staging folder could not be removed."
        }
    }
}
