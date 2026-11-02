$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($env:GEA_SIGNING_PFX_BASE64) -or [string]::IsNullOrWhiteSpace($env:GEA_SIGNING_PASSWORD)) { throw 'Configure GEA_WINDOWS_SIGNING_PFX_BASE64 and GEA_WINDOWS_SIGNING_PASSWORD repository secrets before a signed build.' }
$directory = Join-Path $env:RUNNER_TEMP 'gea-windows-signing'
[IO.Directory]::CreateDirectory($directory) | Out-Null
$pfx = Join-Path $directory 'codesign.pfx'
$password = Join-Path $directory 'password.txt'
[IO.File]::WriteAllBytes($pfx,[Convert]::FromBase64String($env:GEA_SIGNING_PFX_BASE64))
[IO.File]::WriteAllText($password,$env:GEA_SIGNING_PASSWORD,[Text.UTF8Encoding]::new($false))
"GEA_WINDOWS_PFX_FILE=$pfx" | Out-File -Append -FilePath $env:GITHUB_ENV
"GEA_WINDOWS_PFX_PASSWORD_FILE=$password" | Out-File -Append -FilePath $env:GITHUB_ENV
