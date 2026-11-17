param([Parameter(Mandatory=$true)][string]$BuildDirectory,[Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference='Stop'
$sourceRoot=Split-Path $PSScriptRoot -Parent
$output=[IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $output|Out-Null
$compiler=Join-Path $env:SystemRoot 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$arguments=@('/nologo','/target:exe','/main:LogRegression','/codepage:65001',('/out:'+(Join-Path $output 'LogRegression.exe')),'/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll','/reference:System.Core.dll','/reference:System.Web.Extensions.dll','/reference:System.Management.dll','/reference:System.IO.Compression.dll','/reference:System.IO.Compression.FileSystem.dll')
$arguments+=@(Get-ChildItem -LiteralPath $sourceRoot -Filter '*.cs'|Select-Object -ExpandProperty FullName)
$arguments+=@((Join-Path $PSScriptRoot 'LogRegression.cs'),(Join-Path $BuildDirectory 'BuildInfo.cs'))
& $compiler @arguments
if($LASTEXITCODE -ne 0){throw 'REGRESSION_COMPILE_FAILED'}
& (Join-Path $output 'LogRegression.exe') $output
if($LASTEXITCODE -ne 0){throw 'REGRESSION_FAILED'}
Get-Content -LiteralPath (Join-Path $output 'log-regression.json') -Raw

$execution=Join-Path $output 'ExecutionRegression.exe'
$executionArguments=@('/nologo','/target:exe','/main:ExecutionRegression','/codepage:65001',('/out:'+$execution),'/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll','/reference:System.Core.dll','/reference:System.Web.Extensions.dll','/reference:System.Management.dll','/reference:System.IO.Compression.dll','/reference:System.IO.Compression.FileSystem.dll')
$executionArguments+=@(Get-ChildItem -LiteralPath $sourceRoot -Filter '*.cs'|Select-Object -ExpandProperty FullName)
$executionArguments+=@((Join-Path $PSScriptRoot 'ExecutionRegression.cs'),(Join-Path $BuildDirectory 'BuildInfo.cs'))
& $compiler @executionArguments
if($LASTEXITCODE -ne 0){throw 'EXECUTION_REGRESSION_COMPILE_FAILED'}
& $execution $output
if($LASTEXITCODE -ne 0){throw 'EXECUTION_REGRESSION_FAILED'}
Get-Content -LiteralPath (Join-Path $output 'execution-regression.json') -Raw
