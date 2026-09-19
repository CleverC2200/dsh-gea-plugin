param(
  [Parameter(Mandatory=$true)][string]$Installer,
  [Parameter(Mandatory=$true)][string]$Destination,
  [Parameter(Mandatory=$true)][string]$ReportDirectory,
  [Parameter(Mandatory=$true)][string]$Label,
  [int]$TimeoutSeconds = 1500
)
$ErrorActionPreference = 'Stop'
# This destructive timeout cleanup is CI-only and targets only the process tree we started.
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') { throw 'Use only on an isolated GitHub Windows runner' }
$tempRoot = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\') + '\'
foreach ($path in @($Destination,$ReportDirectory)) {
  if (-not [IO.Path]::GetFullPath($path).StartsWith($tempRoot,[StringComparison]::OrdinalIgnoreCase)) { throw 'Paths must be inside this runner temporary directory' }
}
if ($Label -notmatch '^[a-z0-9-]+$') { throw 'Invalid report label' }
New-Item -ItemType Directory -Path $ReportDirectory -Force | Out-Null
$samples = Join-Path $ReportDirectory "$Label-samples.jsonl"
$installerTimingLog = Join-Path $env:TEMP 'GEA-Desktop-install-timing.log'
Remove-Item -LiteralPath $installerTimingLog -Force -ErrorAction SilentlyContinue
$started = [DateTime]::UtcNow
$timer = [Diagnostics.Stopwatch]::StartNew()
$process = Start-Process -FilePath $Installer -ArgumentList '/S', "/D=$Destination" -PassThru
$owned = [Collections.Generic.HashSet[int]]::new()
[void]$owned.Add($process.Id)
$timedOut = $false
$sampleErrors = @()
$peakProcesses = 0
Write-Host "INSTALL_START label=$Label pid=$($process.Id) utc=$($started.ToString('o'))"
try {
  while ($true) {
    $process.Refresh()
    $rows = @(Get-CimInstance Win32_Process)
    # Include NSIS children even when the bootstrap executable exits early.
    do {
      $changed = $false
      foreach ($row in $rows) {
        if ($owned.Contains([int]$row.ParentProcessId) -and $row.CreationDate.ToUniversalTime() -ge $started.AddSeconds(-1)) {
          if ($owned.Add([int]$row.ProcessId)) { $changed = $true }
        }
      }
    } while ($changed)
    $live = @($rows | Where-Object { $owned.Contains([int]$_.ProcessId) -and $_.CreationDate.ToUniversalTime() -ge $started.AddSeconds(-1) })
    $peakProcesses = [Math]::Max($peakProcesses,$live.Count)
    $observed = @($live) + @($rows | Where-Object { $_.Name -eq 'MsMpEng.exe' })
    $disk = @()
    try {
      $disk = @(Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk | Select-Object Name,DiskReadBytesPersec,DiskWriteBytesPersec,CurrentDiskQueueLength,PercentDiskTime)
    } catch { $sampleErrors += $_.Exception.Message }
    $sample = [ordered]@{
      utc = [DateTime]::UtcNow.ToString('o'); elapsedMs = $timer.ElapsedMilliseconds
      rootExited = $process.HasExited
      processes = @($observed | Select-Object Name,ProcessId,ParentProcessId,KernelModeTime,UserModeTime,ReadTransferCount,WriteTransferCount,WorkingSetSize)
      disk = $disk
    }
    $sample | ConvertTo-Json -Depth 6 -Compress | Add-Content -LiteralPath $samples -Encoding utf8
    Write-Host "INSTALL_SAMPLE label=$Label seconds=$([int]$timer.Elapsed.TotalSeconds) live=$($live.Count) rootExited=$($process.HasExited)"
    if ($process.HasExited -and $live.Count -eq 0) { break }
    if ($timer.Elapsed.TotalSeconds -ge $TimeoutSeconds) {
      $timedOut = $true
      foreach ($row in $live) { & taskkill /PID ([string]$row.ProcessId) /T /F 2>&1 | Out-Null }
      break
    }
    Start-Sleep -Seconds 5
  }
} finally {
  $timer.Stop(); $process.Refresh()
  $fileCount = 0; $installedBytes = 0
  if (Test-Path -LiteralPath $Destination) {
    Get-ChildItem -LiteralPath $Destination -File -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object { $fileCount++; $installedBytes += $_.Length }
  }
  $installerTimingLogPresent = Test-Path -LiteralPath $installerTimingLog
  if ($installerTimingLogPresent) {
    Copy-Item -LiteralPath $installerTimingLog -Destination (Join-Path $ReportDirectory "$Label-installer-timing.log") -Force
  }
  $result = [ordered]@{
    label=$Label; startedUtc=$started.ToString('o'); elapsedMs=$timer.ElapsedMilliseconds
    installerSha256=(Get-FileHash -LiteralPath $Installer -Algorithm SHA256).Hash.ToLower()
    exitCode=$(if ($process.HasExited) {$process.ExitCode} else {$null}); timedOut=$timedOut
    executablePresent=(Test-Path -LiteralPath (Join-Path $Destination 'GEA Desktop.exe'))
    installedFileCount=$fileCount; installedBytes=$installedBytes; peakInstallerProcesses=$peakProcesses
    installerTimingLogPresent=$installerTimingLogPresent
    telemetryErrors=@($sampleErrors | Select-Object -Unique)
    scope='Silent NSIS install only; no app startup or user data. Five-second sampling; not exact GUI progress timing.'
  }
  $result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $ReportDirectory "$Label-result.json") -Encoding utf8
  Write-Host ($result | ConvertTo-Json -Compress)
}
if ($timedOut) { throw "Installer exceeded $TimeoutSeconds seconds; telemetry retained" }
if ($process.ExitCode -ne 0 -or -not $result.executablePresent) { throw 'Installer failed or expected executable is absent' }
