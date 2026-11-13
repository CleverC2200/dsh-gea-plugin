param([Parameter(Mandatory=$true)][string]$EngineDirectory,[Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference='Stop'
$manifest=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'engine.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$engine=Join-Path $EngineDirectory 'support-bundle.exe'
$license=Join-Path $EngineDirectory 'LICENSE'
if((Get-FileHash -LiteralPath $engine -Algorithm SHA256).Hash.ToLower() -ne $manifest.windows.executableSha256) {throw 'ENGINE_HASH_MISMATCH'}
if(-not (Test-Path -LiteralPath $license -PathType Leaf)) {throw 'ENGINE_LICENSE_MISSING'}
$output=[IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $output -Force | Out-Null
$info='[assembly:System.Runtime.Versioning.TargetFramework(".NETFramework,Version=v4.8")][assembly:System.Reflection.AssemblyTitle("GEA日志采集")][assembly:System.Reflection.AssemblyProduct("GEA日志采集")] namespace GeaDiagnostics { internal static class BuildInfo { internal const string Version="0.1.2"; internal const string EngineHash="'+$manifest.windows.executableSha256+'"; } }'
$infoPath=Join-Path $output 'BuildInfo.cs'
[IO.File]::WriteAllText($infoPath,$info,[Text.UTF8Encoding]::new($false))
$compiler=Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$target=Join-Path $output 'GEA日志采集.exe'
$arguments=@('/nologo','/target:winexe','/platform:x64','/optimize+','/utf8output','/codepage:65001',('/out:'+$target),('/win32manifest:'+(Join-Path $PSScriptRoot 'app.manifest')),('/resource:'+$engine+',Troubleshoot.Engine'),('/resource:'+$license+',Troubleshoot.License'),'/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll','/reference:System.Core.dll','/reference:System.Web.Extensions.dll','/reference:System.Management.dll','/reference:System.IO.Compression.dll','/reference:System.IO.Compression.FileSystem.dll')
$arguments+=@(Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.cs' | Select-Object -ExpandProperty FullName)
$arguments+=@($infoPath)
& $compiler @arguments
if($LASTEXITCODE -ne 0) {throw 'DIAGNOSTIC_BUILD_FAILED'}
$signature=Get-AuthenticodeSignature -LiteralPath $target
[ordered]@{version='0.1.2';engineVersion=$manifest.version;engineSha256=$manifest.windows.executableSha256;executable=$target;sha256=(Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLower();signature=[string]$signature.Status;stage='unsigned-development-build';publicDistributionApproved=$false}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $output 'build-result.json') -Encoding UTF8
Get-Content -LiteralPath (Join-Path $output 'build-result.json') -Raw
