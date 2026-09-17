param([switch]$Silent, [string]$Destination, [int]$MaxMinutes=60)
$ErrorActionPreference='Stop'
# No process termination, uninstall, security changes, or business-file collection.
if ($Silent -and $env:GITHUB_ACTIONS -ne 'true') { throw 'Silent mode is reserved for disposable CI validation.' }
if ($Destination -and (-not $Silent -or -not ([IO.Path]::GetFullPath($Destination)).StartsWith(([IO.Path]::GetFullPath($env:RUNNER_TEMP)).TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase))) { throw 'CI destination must be inside RUNNER_TEMP.' }
$manifest=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'diagnostic-package.json') -Raw | ConvertFrom-Json
$installer=Join-Path $PSScriptRoot $manifest.file
if ([IO.Path]::GetFileName($manifest.file) -ne $manifest.file) { throw 'Invalid installer filename' }
Write-Host 'Verifying diagnostic installer. Please wait...'
if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLower() -ne $manifest.sha256) { throw 'Installer checksum mismatch. Extract the complete diagnostic package again.' }
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$admin=([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$output=Join-Path $PSScriptRoot ('GEA-report-'+(Get-Date -Format 'yyyyMMdd-HHmmss')+'-'+[Guid]::NewGuid().ToString('N').Substring(0,6))
New-Item -ItemType Directory -Path $output | Out-Null
$previousDir=$env:GEA_DIAG_DIR
$env:GEA_DIAG_DIR=$output
$started=[DateTime]::UtcNow
$watch=[Diagnostics.Stopwatch]::StartNew()
$reason='unknown'; $samples=0; $root=$null; $lastLive=@(); $lastSnapshot=0
function Save-Json($name,$value) { $value | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $output $name) -Encoding utf8 }
function Record-Error($stage,$errorRecord) {
  # Error type is enough to explain missing telemetry; omit paths and identifiers.
  @{utc=[DateTime]::UtcNow.ToString('o');stage=$stage;type=$errorRecord.Exception.GetType().FullName;id=($errorRecord.FullyQualifiedErrorId -split ',')[0]} | ConvertTo-Json -Compress | Add-Content -LiteralPath (Join-Path $output 'collection-errors.jsonl') -Encoding utf8
}
function Export-Report {
  Save-Json 'result.json' ([ordered]@{schema=2;startedUtc=$started.ToString('o');elapsedMs=$watch.ElapsedMilliseconds;reason=$reason;sampleCount=$samples;installerSha256=$manifest.sha256;rootExited=($root -and $root.HasExited);exitCode=$(if($root -and $root.HasExited){$root.ExitCode}else{$null});liveProcessCount=$lastLive.Count;collectorElevated=$admin;stageFiles=@(Get-ChildItem -LiteralPath $output -Filter 'stages-*.log' | Select-Object -ExpandProperty Name)})
  # A snapshot is independent of the live files and survives closing the console.
  $zip=$output+'-snapshot-'+$watch.ElapsedMilliseconds+'.zip'
  try { Compress-Archive -Path (Join-Path $output '*') -DestinationPath $zip -CompressionLevel Fastest; Write-Host "Report saved: $zip" } catch { Record-Error 'zip' $_; Write-Host "Raw report remains available: $output" }
}
try {
  $environment=[ordered]@{schema=2;collectorElevated=$admin;powerShell=$PSVersionTable.PSVersion.ToString();timezone=[TimeZoneInfo]::Local.Id;processArchitecture=$env:PROCESSOR_ARCHITECTURE;tempDrive=[IO.Path]::GetPathRoot($env:TEMP);installerDrive=[IO.Path]::GetPathRoot($installer)}
  try {$environment.windowsRelease=Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' | Select-Object DisplayVersion,CurrentBuildNumber,UBR,EditionID} catch {Record-Error 'windows-release' $_}
  try {$environment.physicalDisks=@(Get-PhysicalDisk | Select-Object MediaType,BusType,Size,HealthStatus)} catch {Record-Error 'physical-disks' $_}
  foreach($item in @(@('os','Win32_OperatingSystem',@('Caption','Version','BuildNumber','OSArchitecture','TotalVisibleMemorySize','FreePhysicalMemory')), @('cpu','Win32_Processor',@('Name','NumberOfCores','NumberOfLogicalProcessors')), @('disks','Win32_DiskDrive',@('Model','MediaType','Size','InterfaceType')), @('volumes','Win32_LogicalDisk',@('DeviceID','DriveType','FileSystem','Size','FreeSpace')))) {
    try { $environment[$item[0]]=@(Get-CimInstance -ClassName $item[1] | Select-Object -Property $item[2]) } catch { Record-Error $item[0] $_ }
  }
  try { $environment.antivirus=@(Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntivirusProduct | Select-Object displayName,productState) } catch { Record-Error 'security-center' $_ }
  try { $environment.defender=Get-MpComputerStatus | Select-Object AMServiceEnabled,AntivirusEnabled,RealTimeProtectionEnabled,BehaviorMonitorEnabled,IoavProtectionEnabled,AntivirusSignatureVersion } catch { Record-Error 'defender' $_ }
  Save-Json 'environment.json' $environment
  Write-Host 'Installing with live diagnostics. Use the installer normally.'
  Write-Host 'At the finish page, UNCHECK launch application, then close the installer.'
  Write-Host 'Keep this console open. S saves a snapshot; Q ends collection WITHOUT stopping installation.'
  Write-Host "Reports: $output"
  $argsForInstaller=@()
  if($Silent){$argsForInstaller=@('/S',"/D=$Destination")}
  if($argsForInstaller.Count){$root=Start-Process -FilePath $installer -ArgumentList $argsForInstaller -PassThru}else{$root=Start-Process -FilePath $installer -PassThru}
  $owned=@{}; $owned[[int]$root.Id]=$root.StartTime.ToUniversalTime()
  $avNames=@('MsMpEng.exe','MsSense.exe','NisSrv.exe','SecurityHealthService.exe','360tray.exe','360sd.exe','QQPCTray.exe','HipsDaemon.exe','avp.exe','ekrn.exe','SophosFileScanner.exe','SentinelAgent.exe')
  $emptyPolls=0
  while($true){
    $sampleStart=$watch.ElapsedMilliseconds
    $root.Refresh()
    try {
      $rows=@(Get-CimInstance Win32_Process)
      do {
        $changed=$false
        foreach($row in $rows){
          if($null -eq $row.CreationDate){continue}
          $created=$row.CreationDate.ToUniversalTime(); $parent=[int]$row.ParentProcessId; $id=[int]$row.ProcessId
          if($owned.ContainsKey($parent) -and $created -ge $owned[$parent] -and $created -ge $started.AddSeconds(-1) -and -not $owned.ContainsKey($id)){$owned[$id]=$created;$changed=$true}
        }
      } while($changed)
      $lastLive=@($rows | Where-Object {$null -ne $_.CreationDate -and $owned.ContainsKey([int]$_.ProcessId) -and [Math]::Abs(($_.CreationDate.ToUniversalTime()-$owned[[int]$_.ProcessId]).TotalSeconds) -lt 2})
      $observed=@($lastLive)+@($rows | Where-Object {$avNames -contains $_.Name})
      $disk=@(); try {$disk=@(Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk | Select-Object Name,DiskReadBytesPersec,DiskWriteBytesPersec,CurrentDiskQueueLength,PercentDiskTime)}catch{Record-Error 'disk-sample' $_}
      [ordered]@{utc=[DateTime]::UtcNow.ToString('o');elapsedMs=$watch.ElapsedMilliseconds;rootExited=$root.HasExited;processes=@($observed | Select-Object Name,ProcessId,ParentProcessId,KernelModeTime,UserModeTime,ReadTransferCount,WriteTransferCount,WorkingSetSize);disk=$disk} | ConvertTo-Json -Depth 6 -Compress | Add-Content -LiteralPath (Join-Path $output 'samples.jsonl') -Encoding utf8
      $samples++
      # NSIS stage PIDs also identify elevated children if their parent disappears between polls.
      foreach($file in @(Get-ChildItem -LiteralPath $output -Filter 'stages-*.log')){
        if($file.BaseName -match '^stages-(\d+)$'){
          $stageId=[int]$Matches[1]
          $row=$rows | Where-Object {$_.ProcessId -eq $stageId -and $null -ne $_.CreationDate -and $_.CreationDate.ToUniversalTime() -ge $started.AddSeconds(-1)} | Select-Object -First 1
          if($row){$owned[$stageId]=$row.CreationDate.ToUniversalTime()}
        }
      }
      if($root.HasExited -and $lastLive.Count -eq 0){$emptyPolls++}else{$emptyPolls=0}
      if($emptyPolls -ge 2){$reason='process-tree-exited';break}
    } catch {Record-Error 'process-sample' $_}
    if($watch.Elapsed.TotalMinutes -ge $MaxMinutes){$reason='collection-time-limit-installer-not-terminated';break}
    if(-not $Silent){
      try {
        if([Console]::KeyAvailable){
          $key=[Console]::ReadKey($true).Key
          if($key -eq 'S'){$reason='manual-snapshot-installation-continues';Export-Report}
          if($key -eq 'Q'){$reason='manual-stop-installer-not-terminated';break}
        }
      }catch{}
    }
    if($watch.ElapsedMilliseconds-$lastSnapshot -gt 60000){$lastSnapshot=$watch.ElapsedMilliseconds;Write-Host ("Collecting: {0:n0}s, samples={1}, installer processes={2}" -f $watch.Elapsed.TotalSeconds,$samples,$lastLive.Count)}
    $delay=[Math]::Max(100,3000-($watch.ElapsedMilliseconds-$sampleStart));Start-Sleep -Milliseconds $delay
  }
} catch {$reason='collector-error';Record-Error 'collector' $_;Write-Host 'Collection encountered an error. Saving available evidence.'}
finally {
  $watch.Stop()
  # The fallback is used if elevation does not inherit the diagnostic environment variable.
  $fallback=Join-Path $env:TEMP 'GEA-Install-Diagnostics'
  if(Test-Path -LiteralPath $fallback){Get-ChildItem -LiteralPath $fallback -Filter 'stages-*.log' | Where-Object {$_.LastWriteTimeUtc -ge $started} | ForEach-Object {Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $output ('fallback-'+$_.Name))}}
  Export-Report
  $env:GEA_DIAG_DIR=$previousDir
}
if($Silent){
  if($reason -ne 'process-tree-exited' -or $root.ExitCode -ne 0){throw 'CI installation did not complete successfully'}
  $logs=(@(Get-ChildItem -LiteralPath $output -Filter '*stages-*.log' | ForEach-Object {Get-Content -LiteralPath $_.FullName}) -join "`n")
  foreach($stage in @('install-section-begin','check-running-begin','check-running-end','uninstall-SHELL_CONTEXT-begin','uninstall-SHELL_CONTEXT-end','embedded-archive-begin','embedded-archive-end','sevenzip-extract-begin','sevenzip-extract-end','copy-files-begin','copy-files-end','cache-installer-begin','cache-installer-end','registry-begin','registry-end','install-complete','install-success')){if($logs -notmatch ([Regex]::Escape($stage)+'(\r?\n|$)')){throw "Missing installer phase: $stage"}}
}
