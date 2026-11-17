param([Parameter(Mandatory=$true)][string]$Executable,[Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference='Stop'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
if(([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'TEST_REQUIRES_ORDINARY_TOKEN'}
New-Item -ItemType Directory -Path $OutputDirectory | Out-Null
$assembly=[Reflection.Assembly]::LoadFrom([IO.Path]::GetFullPath($Executable))
$flags=[Reflection.BindingFlags]'Public,NonPublic,Static,Instance'
$privacy=$assembly.GetType('GeaDiagnostics.Privacy')
$collection=$assembly.GetType('GeaDiagnostics.Collection')
$probe=$assembly.GetType('GeaDiagnostics.Probe')
function Invoke-Static($type,$name,[object[]]$values){
 $method=$type.GetMethod($name,$flags);$parameters=$method.GetParameters()
 for($index=0;$index -lt $values.Length;$index++){$values[$index]=[Management.Automation.LanguagePrimitives]::ConvertTo($values[$index],$parameters[$index].ParameterType)}
 $method.Invoke($null,$values)
}
function Assert($value,$name){if(-not $value){throw ('ASSERTION_FAILED: '+$name)}}
$raw='{"event":"backend-error","requestId":"public-request-17","errorCode":"UPDATE_PRECHECK_TIMEOUT","body":"private-body-17","password":"private-password-17","targets":[{"packageName":"@cleverc2200/gea-dsh-prototype","targetVersion":"0.0.287","archivePath":"private-path-17"}]}'
$projected=Invoke-Static $privacy 'TechnicalText' @($raw)
Assert ($projected -match 'public-request-17' -and $projected -match '0.0.287' -and $projected -notmatch 'private-') 'structured projection'
$dirty='Authorization: Bearer private-bearer-17 Cookie: private-cookie-17 C:\Users\private-user-17\app.js https://private-user:private-pass@example.test/a?token=private-query-17 private-mail@example.test'
$clean=Invoke-Static $privacy 'Clean' @($dirty)
Assert ($clean -notmatch 'private-') 'text redaction'
$unicode=Join-Path $OutputDirectory 'large-utf16.log'
[IO.File]::WriteAllText($unicode,('x'*1100000)+"`nUPDATE_PRECHECK_TIMEOUT`n",[Text.Encoding]::Unicode)
$tail=Invoke-Static $privacy 'ReadBounded' @($unicode,1048576)
Assert ($tail.Contains('UPDATE_PRECHECK_TIMEOUT')) 'bounded UTF16'
$run=Join-Path $env:TEMP ('GEA-native-probe-'+[Guid]::NewGuid().ToString('N'))
$plan=Invoke-Static $collection 'Create' @($run)
$plan.Fixture=$false
$results=@()
foreach($group in @('environment','startup','events','performance')){
 $dir=Join-Path $run ($group+'-native');$constructor=$probe.GetConstructor($flags,$null,[type[]]@($plan.GetType(),[string],[string]),$null)
 $instance=$constructor.Invoke([object[]]@($plan,[string]$group,[string]$dir));$exit=$probe.GetMethod('Run',$flags).Invoke($instance,@())
 $coverage=Get-Content -LiteralPath (Join-Path $dir 'coverage.json') -Raw|ConvertFrom-Json
 $results+=@{group=$group;exitCode=$exit;coverage=$coverage}
 if($group -eq 'startup'){Assert (Test-Path (Join-Path $dir 'launch-snapshot.txt')) 'native startup snapshot'}
 if($group -eq 'environment'){
  $system=Get-Content -LiteralPath (Join-Path $dir 'system.txt') -Raw|ConvertFrom-Json
  Assert (-not $system.elevated) 'native ordinary environment'
  Assert (Test-Path (Join-Path $dir 'network.txt')) 'native network collection'
  $network=Get-Content -LiteralPath (Join-Path $dir 'network.txt') -Raw|ConvertFrom-Json
  Assert (@($network).Count -eq 2) 'both network targets'
 }
}
$plan.AppRoots=@(Join-Path $run 'missing-app');$dir=Join-Path $run 'missing-startup'
$instance=$probe.GetConstructor($flags,$null,[type[]]@($plan.GetType(),[string],[string]),$null).Invoke([object[]]@($plan,'startup',[string]$dir))
$null=$probe.GetMethod('Run',$flags).Invoke($instance,@())
$missing=Get-Content -LiteralPath (Join-Path $dir 'coverage.json') -Raw|ConvertFrom-Json
Assert ($missing.status -eq 'partial' -and $missing.items.code -contains 'NO_PERSISTED_STARTUP_LOG') 'missing differs from healthy'
$cancelRun=Join-Path $env:TEMP ('GEA-cancel-probe-'+[Guid]::NewGuid().ToString('N'))
$cancelPlan=Invoke-Static $collection 'Create' @($cancelRun)
$token=[Threading.CancellationTokenSource]::new();$token.Cancel()
$unrelated=Start-Process -FilePath (Join-Path $env:SystemRoot 'System32/ping.exe') -ArgumentList @('-n','30','127.0.0.1') -WindowStyle Hidden -PassThru
$cancelled=$false
try{Invoke-Static $collection 'Collect' @($cancelPlan,[Action[string,int]]{param($text,$percent)},$token.Token)}catch{ $cancelled=$_.Exception.InnerException -is [OperationCanceledException] -or $_.Exception.InnerException.InnerException -is [OperationCanceledException] }
Assert $cancelled 'cancellation propagated'
$unrelated.Refresh();Assert (-not $unrelated.HasExited) 'unrelated process preserved'
$unrelated.Kill();$unrelated.WaitForExit();$unrelated.Dispose();$token.Dispose()
Start-Sleep -Milliseconds 500
$ownedLeft=@(Get-CimInstance Win32_Process | Where-Object {$_.CommandLine -and $_.CommandLine.Contains($cancelRun) -and $_.ProcessId -ne $PID})
Assert ($ownedLeft.Count -eq 0) 'cancelled process tree stopped'
$lateRun=Join-Path $env:TEMP ('GEA-late-cancel-'+[Guid]::NewGuid().ToString('N'))
$latePlan=Invoke-Static $collection 'Create' @($lateRun)
$lateToken=[Threading.CancellationTokenSource]::new();$lateCancelled=$false
try {Invoke-Static $collection 'Collect' @($latePlan,[Action[string,int]]{param($text,$percent) if($percent -eq 80){$lateToken.Cancel()}},$lateToken.Token)} catch {$lateCancelled=$_.Exception.InnerException -is [OperationCanceledException] -or $_.Exception.InnerException.InnerException -is [OperationCanceledException]}
Assert $lateCancelled 'packaging cancellation propagated'
Assert (@(Get-ChildItem $lateRun -Filter '*.zip*').Count -eq 0) 'no incomplete desktop archive'
$lateToken.Dispose()
[ordered]@{passed=$true;elevated=$false;privacyProjection=$true;utf16Tail=$true;missingReported=$true;cancellation=$true;packagingCancellation=$true;unrelatedProcessPreserved=$true;nativeProbes=$results;run=$run}|ConvertTo-Json -Depth 10|Set-Content -LiteralPath (Join-Path $OutputDirectory 'test-result.json') -Encoding UTF8
Write-Output 'DIAGNOSTIC_TESTS_PASSED'
