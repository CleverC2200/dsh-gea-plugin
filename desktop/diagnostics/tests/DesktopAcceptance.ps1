param([Parameter(Mandatory=$true)][string]$Executable,[Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
if(([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'ORDINARY_TOKEN_REQUIRED'}
New-Item -ItemType Directory -Path $OutputDirectory -Force|Out-Null
Add-Type -AssemblyName System.Windows.Forms,System.Drawing,UIAutomationClient,UIAutomationTypes,System.IO.Compression.FileSystem
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class GeaCapture{[StructLayout(LayoutKind.Sequential)]public struct Rect{public int left,top,right,bottom;}[DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out Rect r);[DllImport("user32.dll")]public static extern bool PrintWindow(IntPtr h,IntPtr dc,uint flags);[DllImport("user32.dll",SetLastError=true)]public static extern IntPtr SendMessageTimeout(IntPtr h,uint message,IntPtr w,IntPtr l,uint flags,uint timeout,out IntPtr result);}'
$executable=[IO.Path]::GetFullPath($Executable)
$assembly=[Reflection.Assembly]::LoadFrom($executable)
if($assembly.GetManifestResourceNames().Length -ne 0){throw 'EMBEDDED_ENGINE_PRESENT'}
$flags=[Reflection.BindingFlags]'Public,NonPublic,Static,Instance'
$collection=$assembly.GetType('GeaDiagnostics.Collection')
$fixture=Join-Path $env:TEMP ('GEA-default-fixture-'+[Guid]::NewGuid().ToString('N'))
$plan=$collection.GetMethod('Create',$flags).Invoke($null,[object[]]@([string]$fixture))
$customHome=Join-Path $fixture 'home'
$profile=Join-Path $customHome 'profiles/desktop'
New-Item -ItemType Directory -Path (Split-Path $profile -Parent) -Force|Out-Null
Move-Item -LiteralPath $plan.Profiles[0] -Destination $profile
$env:DSH_HOME=$customHome
$env:DSH_GEA_DESKTOP_DATA=$plan.AppRoots[0]
$desktop=[Environment]::GetFolderPath('DesktopDirectory')
$before=@(Get-ChildItem -LiteralPath $desktop -Filter 'GEA日志采集-*.zip' -ErrorAction SilentlyContinue|Select-Object -ExpandProperty FullName)
$process=$null
function Assert($ok,[string]$message){if(!$ok){throw $message}}
function Root { [Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle) }
function Find([string]$name) { (Root).FindFirst([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty,$name)) }
function Click($element){$handle=[IntPtr]$element.Current.NativeWindowHandle;Assert ($handle -ne [IntPtr]::Zero) 'BUTTON_HANDLE_MISSING';$reply=[IntPtr]::Zero;Assert ([GeaCapture]::SendMessageTimeout($handle,0xF5,[IntPtr]::Zero,[IntPtr]::Zero,2,5000,[ref]$reply) -ne [IntPtr]::Zero) 'BUTTON_CLICK_FAILED'}
function Wait-For([scriptblock]$predicate,[int]$seconds=90){$clock=[Diagnostics.Stopwatch]::StartNew();while($clock.Elapsed.TotalSeconds -lt $seconds){if(&$predicate){return};$process.Refresh();if($process.HasExited){throw 'CLIENT_EARLY_EXIT'};Start-Sleep -Milliseconds 150};throw 'UI_ACCEPTANCE_TIMEOUT'}
try {
 $start=[Diagnostics.ProcessStartInfo]::new($executable);$start.UseShellExecute=$true
 $process=[Diagnostics.Process]::Start($start)
 Wait-For {$process.Refresh();$process.MainWindowHandle -ne [IntPtr]::Zero}
 Assert ($process.MainWindowTitle -eq 'GEA日志采集') 'DEFAULT_WINDOW_MISSING'
 Wait-For {$null -ne (Find '日志包已保存')}
 $archive=@(Get-ChildItem -LiteralPath $desktop -Filter 'GEA日志采集-*.zip'|Where-Object{$_.FullName -notin $before})
 Assert ($archive.Count -eq 1) 'DESKTOP_ARCHIVE_NOT_UNIQUE'
 $zip=[IO.Compression.ZipFile]::OpenRead($archive[0].FullName)
 try {
  $reader=[IO.StreamReader]::new($zip.GetEntry('收集清单.json').Open());try{$manifest=$reader.ReadToEnd()|ConvertFrom-Json}finally{$reader.Dispose()}
  Assert ($manifest.groups.Count -eq 6) 'GROUPS_MISSING'
  $systemEntry=$zip.GetEntry('诊断数据/environment/system.txt');Assert ($null -ne $systemEntry) 'ENVIRONMENT_MISSING'
  $reader=[IO.StreamReader]::new($systemEntry.Open());try{$system=$reader.ReadToEnd()|ConvertFrom-Json}finally{$reader.Dispose()}
  Assert (-not $system.elevated) 'COLLECTOR_ELEVATED'
  foreach($entry in $zip.Entries){$reader=[IO.StreamReader]::new($entry.Open());try{$text=$reader.ReadToEnd();Assert ($text -notmatch 'sensitive-fixture-') 'PRIVACY_CANARY_LEAKED'}finally{$reader.Dispose()}}
 }finally{$zip.Dispose()}
 $box=[GeaCapture+Rect]::new();$null=[GeaCapture]::GetWindowRect($process.MainWindowHandle,[ref]$box)
 $bitmap=[Drawing.Bitmap]::new($box.right-$box.left,$box.bottom-$box.top);$graphics=[Drawing.Graphics]::FromImage($bitmap);$dc=$graphics.GetHdc()
 try{$null=[GeaCapture]::PrintWindow($process.MainWindowHandle,$dc,2)}finally{$graphics.ReleaseHdc($dc)}
 $bitmap.Save((Join-Path $OutputDirectory 'default-window.png'));$graphics.Dispose();$bitmap.Dispose()
 Copy-Item -LiteralPath $archive[0].FullName -Destination (Join-Path $OutputDirectory 'acceptance-report.zip')
 $copy=Find '复制摘要';Assert ($null -ne $copy) 'COPY_BUTTON_MISSING'
 Click $copy
 Start-Sleep -Milliseconds 300
 $summary=[Windows.Forms.Clipboard]::GetText();Assert ($summary.Contains($archive[0].Name)) 'SUMMARY_NOT_COPIED'
 $render=Join-Path $OutputDirectory 'RenderValidation.exe'
 $compiler=Join-Path $env:SystemRoot 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
 & $compiler /nologo /target:exe /main:RenderValidation /codepage:65001 /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /out:$render (Join-Path $PSScriptRoot 'Render.cs')
 Assert ($LASTEXITCODE -eq 0) 'RENDER_HELPER_COMPILE_FAILED'
 foreach($mode in @('cancel','close')){& $render $executable $OutputDirectory $mode;Assert ($LASTEXITCODE -eq 0) ('UI_'+$mode+'_FAILED')}
 $folder=Find '打开文件夹';Assert ($null -ne $folder) 'FOLDER_BUTTON_MISSING'
 Click $folder
 $shell=New-Object -ComObject Shell.Application
 $folderVerified=$false;$clock=[Diagnostics.Stopwatch]::StartNew()
 while(!$folderVerified -and $clock.Elapsed.TotalSeconds -lt 20){foreach($window in @($shell.Windows())){try{$items=$window.Document.SelectedItems();for($index=0;$index -lt $items.Count;$index++){if($items.Item($index).Path -eq $archive[0].FullName){$folderVerified=$true}}}catch{}};if(!$folderVerified){Start-Sleep -Milliseconds 200}}
 $explorer=@(Get-CimInstance Win32_Process -Filter "Name='explorer.exe'"|Select-Object ProcessId,ParentProcessId,SessionId,CommandLine)
 $windows=@();foreach($window in @($shell.Windows())){try{$items=$window.Document.SelectedItems();$selected=@();for($index=0;$index -lt $items.Count;$index++){$selected+=@($items.Item($index).Path)};$windows+=@{name=$window.Name;url=$window.LocationURL;hwnd=$window.HWND;selectedCount=$items.Count;selected=$selected;focused=$window.Document.FocusedItem.Path}}catch{$windows+=@{error=$_.Exception.Message}}}
 [ordered]@{expected=$archive[0].FullName;verified=$folderVerified;explorer=$explorer;windows=$windows;session=[Diagnostics.Process]::GetCurrentProcess().SessionId}|ConvertTo-Json -Depth 8|Set-Content -LiteralPath (Join-Path $OutputDirectory 'explorer-result.json') -Encoding UTF8
 Assert $folderVerified 'ARCHIVE_NOT_SELECTED_IN_EXPLORER'
 $result=[ordered]@{passed=$true;elevated=$false;defaultLaunchWithoutArguments=$true;nativeWindow=$true;zipReadable=$true;groups=$manifest.groups.Count;partial=$manifest.partial;privacyCanariesAbsent=$true;clipboardSummary=$true;explorerSelectedArchive=$true;cancelWindow=$true;closeWaitsForCancellation=$true;embeddedResources=$assembly.GetManifestResourceNames().Length}
 $result|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $OutputDirectory 'ordinary-ui-result.json') -Encoding UTF8
 Copy-Item -LiteralPath $archive[0].FullName -Destination (Join-Path $OutputDirectory 'acceptance-report.zip')
} catch {
 [ordered]@{passed=$false;elevated=$false;error=$_.Exception.Message}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $OutputDirectory 'ordinary-ui-result.json') -Encoding UTF8
 throw
} finally {
 if($process){$process.Refresh();if(!$process.HasExited){$null=$process.CloseMainWindow();if(!$process.WaitForExit(15000)){$process.Kill();$process.WaitForExit()}};$process.Dispose()}
}
