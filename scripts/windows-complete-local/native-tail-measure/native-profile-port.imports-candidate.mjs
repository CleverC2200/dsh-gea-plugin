import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const portConfig = servicePort => ({ host: '127.0.0.1', port: servicePort, compression: 'gzip', compressionLevel: 1, compressionThresholdBytes: 1024 });
function validPort(port) {
  assert(Number.isSafeInteger(port) && port > 1024 && port <= 65535 && port !== 19387, 'OWN_SERVICE_PORT_REQUIRED');
}
export async function assertServicePortAvailable(servicePort) {
  validPort(servicePort);
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(servicePort, '127.0.0.1', () => server.close(error => error ? reject(error) : resolve()));
  });
}
export async function prepareServiceProfile({ profile, servicePort, fresh, boot, yaml }) {
  validPort(servicePort);
  if (fresh) {
    await assert.rejects(stat(join(profile, 'package.json')), { code: 'ENOENT' }, 'FRESH_PROFILE_MUST_NOT_EXIST');
    boot.initProfile(profile, boot.PROFILE_TEMPLATES.web.bundles);
    const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'));
    assert.deepEqual(manifest.dependencies, {}, 'FRESH_COMPANY_PACKAGES_MUST_BE_ABSENT');
    assert.deepEqual(manifest.dsh.profile.bundles, boot.PROFILE_TEMPLATES.web.bundles, 'OFFICIAL_EMPTY_PROFILE_REQUIRED');
  }
  const path = join(profile, 'cordis.patch.yml');
  const patch = yaml.parse(await readFile(path, 'utf8')) ?? [];
  assert(Array.isArray(patch) && !patch.some(row => row.id === 'webserver'), 'UNEXPECTED_EXISTING_SERVICE_PORT_PATCH');
  patch.push({ id: 'webserver', config: portConfig(servicePort) });
  await writeFile(path, yaml.stringify(patch), { mode: 0o600 });
  await assertProfileServicePort(profile, servicePort, yaml);
}
export async function assertProfileServicePort(profile, servicePort, yaml) {
  validPort(servicePort);
  const patch = yaml.parse(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'));
  assert(Array.isArray(patch), 'SERVICE_PROFILE_PATCH_REQUIRED');
  const rows = patch.filter(row => row.id === 'webserver');
  assert.equal(rows.length, 1, 'ONE_SERVICE_PORT_PATCH_REQUIRED');
  assert.deepEqual(rows[0], { id: 'webserver', config: portConfig(servicePort) }, 'SERVICE_PROFILE_PORT_CHANGED');
}
export async function verifyServiceListener(origin, servicePort, appPid) {
  validPort(servicePort);
  assert.equal(origin, `http://127.0.0.1:${servicePort}`, 'ACTUAL_HOST_PORT_MISMATCH');
  assert(Number.isSafeInteger(appPid) && appPid > 1, 'OWN_APP_PID_REQUIRED');
  let listenerPids, parentOf;
  if (process.platform === 'darwin') {
    const result = await execute('/usr/sbin/lsof', ['-nP', `-iTCP:${servicePort}`, '-sTCP:LISTEN', '-Fp']);
    listenerPids = [...new Set(result.stdout.split('\n').filter(row => /^p\d+$/.test(row)).map(row => Number(row.slice(1))))];
    parentOf = async pid => Number((await execute('/bin/ps', ['-p', String(pid), '-o', 'ppid='])).stdout.trim());
  } else {
    assert.equal(process.platform, 'win32', 'NATIVE_LISTENER_PLATFORM_REQUIRED');
    const powershell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const script = `Import-Module ($PSHOME + '\\Modules\\CimCmdlets\\CimCmdlets.psd1') -ErrorAction Stop; Import-Module ($PSHOME + '\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop; Import-Module ($env:SystemRoot + '\\System32\\WindowsPowerShell\\v1.0\\Modules\\NetTCPIP\\NetTCPIP.psd1') -ErrorAction Stop; $ErrorActionPreference='Stop'; $owners=@(Get-NetTCPConnection -State Listen -LocalPort ${servicePort} | Select-Object -ExpandProperty OwningProcess -Unique); $rows=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId); @{owners=$owners;processes=$rows}|ConvertTo-Json -Depth 4 -Compress`;
    const result = JSON.parse((await execute(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true })).stdout);
    listenerPids = result.owners;
    const parents = new Map(result.processes.map(row => [row.ProcessId, row.ParentProcessId]));
    parentOf = async pid => parents.get(pid);
  }
  assert(Array.isArray(listenerPids) && listenerPids.length > 0, 'ACTUAL_SERVICE_LISTENER_REQUIRED');
  for (const listener of listenerPids) {
    let ancestor = listener;
    for (let depth = 0; depth < 32 && ancestor > 1 && ancestor !== appPid; depth++) ancestor = await parentOf(ancestor);
    assert.equal(ancestor, appPid, 'SERVICE_LISTENER_NOT_OWNED');
  }
  return { origin, servicePort, appPid, listenerPids, ownedAppAncestorConfirmed: true };
}
