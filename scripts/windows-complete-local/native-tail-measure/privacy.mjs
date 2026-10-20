import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export async function assertPrivate(path) {
  if (process.platform !== 'win32') {
    const mode = (await stat(path)).mode & 0o777;
    assert([0o600, 0o700].includes(mode), 'PRIVATE_POSIX_MODE_REQUIRED');
    return;
  }
  const command = "$ErrorActionPreference='Stop'; $path=$env:R9_PRIVATE_PATH; $attributes=[IO.File]::GetAttributes($path); if(($attributes -band [IO.FileAttributes]::Directory) -ne 0){$acl=[IO.Directory]::GetAccessControl($path)}else{$acl=[IO.File]::GetAccessControl($path)}; $me=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){if($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $rule.IdentityReference.Value -ne $me -and $rule.IdentityReference.Value -ne 'S-1-5-18'){exit 3}}; [Console]::Out.WriteLine('OWNER_ONLY')";
  const result = await execute(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', command], { env: { ...process.env, R9_PRIVATE_PATH: path }, windowsHide: true, timeout: 10000 });
  assert.equal(result.stdout.trim(), 'OWNER_ONLY', 'PRIVATE_WINDOWS_ACL_REQUIRED');
}
export async function privateJson(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await chmod(path, 0o600);
  await assertPrivate(path);
}
export async function readPrivate(path) {
  await assertPrivate(path);
  return JSON.parse(await readFile(path, 'utf8'));
}
