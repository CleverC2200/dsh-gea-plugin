/** Receive an existing three-package delivery in one new official profile. Never rebuild or publish. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, lstat, realpath } from 'node:fs/promises';
import { join, dirname, basename, isAbsolute, relative } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { artifactSetSha256, digest, pluginNames, deliveryStates, bindReception } from './plugin-reception/contract.mjs';

const json = async file => JSON.parse(await readFile(file, 'utf8'));
const within = (root, path) => { const rel = relative(root, path); return rel === '' || (!rel.startsWith('../') && rel !== '..' && !isAbsolute(rel)); };
const absent = async path => { try { await lstat(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; } throw Error('RECEPTION_NEW_PATH_REQUIRED'); };

export async function receiveDelivery(input) {
  for (const key of ['manifest', 'core', 'pnpm', 'home', 'evidence']) assert(isAbsolute(input[key] ?? ''), 'RECEPTION_ABSOLUTE_INPUT_REQUIRED');
  const manifestPath = await realpath(input.manifest), core = await realpath(input.core), pnpm = await realpath(input.pnpm);
  const home = join(await realpath(dirname(input.home)), basename(input.home));
  const evidence = join(await realpath(dirname(input.evidence)), basename(input.evidence));
  for (const protectedRoot of [core, dirname(manifestPath), import.meta.dirname, dirname(import.meta.dirname)]) {
    assert(!within(protectedRoot, home) && !within(protectedRoot, evidence), 'RECEPTION_OUTPUT_IN_PROTECTED_INPUT');
  }
  assert(!within(home, evidence) && !within(evidence, home), 'RECEPTION_HOME_EVIDENCE_OVERLAP');
  await absent(home); await absent(evidence);
  const supported = await json(new URL('./current-core.json', import.meta.url));
  const manifestBytes = await readFile(manifestPath), manifest = JSON.parse(manifestBytes);
  assert(deliveryStates.includes(manifest.status) && manifest.core?.head === supported.adaptation && manifest.core?.version === supported.version, 'RECEPTION_DELIVERY_CORE_INVALID');
  const actualHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: core, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  assert(actualHead === supported.adaptation && (await json(join(core, 'apps/cli/package.json'))).version === supported.version, 'RECEPTION_CORE_INVALID');
  assert(manifest.packages?.length === 3 && pluginNames.every(name => manifest.packages.filter(row => row.name === name).length === 1), 'RECEPTION_THREE_PACKAGES_REQUIRED');
  const artifacts = [], packageManifests = [];
  for (const name of pluginNames) {
    const row = manifest.packages.find(row => row.name === name);
    assert(typeof row.filename === 'string' && row.filename === basename(row.filename), 'RECEPTION_ARCHIVE_NAME_INVALID');
    const file = await realpath(join(dirname(manifestPath), 'packages', row.filename));
    assert(within(join(dirname(manifestPath), 'packages'), file), 'RECEPTION_ARCHIVE_OUTSIDE_DELIVERY');
    assert(digest(await readFile(file)) === row.sha256, 'RECEPTION_ARCHIVE_DIGEST_MISMATCH');
    const pkg = JSON.parse(execFileSync('tar', ['-xOf', file, 'package/package.json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    assert(pkg.name === row.name && pkg.version === row.version, 'RECEPTION_ARCHIVE_IDENTITY_MISMATCH');
    artifacts.push({ ...row, file }); packageManifests.push(pkg);
  }
  await mkdir(evidence, { recursive: false, mode: 0o700 });
  const resultFile = join(evidence, 'result.json'), profile = join(home, 'profiles/reception');
  const result = { status: 'receiving', success: false, nativeRun: false, modelTasks: 0, businessQueries: 0, artifactSetSha256: artifactSetSha256(artifacts), manifestSha256: digest(manifestBytes) };
  await writeFile(resultFile, JSON.stringify(result, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  try {
    const entry = join(import.meta.dirname, 'plugin-reception/empty-profile.mjs');
    const installPath = join(evidence, 'install.json'), observePath = join(evidence, 'observe.json');
    const common = ['--core', core, '--home', home, '--profile', profile];
    for (const [mode, args] of [
      ['install', [...common, '--mode', 'install', '--pnpm', pnpm, '--workbench', artifacts[0].file, '--manage', artifacts[1].file, '--gea', artifacts[2].file, '--receipt', installPath]],
      ['observe', [...common, '--mode', 'observe', '--receipt', observePath]],
    ]) {
      const child = spawnSync(process.execPath, [entry, ...args], { cwd: evidence, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', DSH_TELEMETRY_DISABLED: '1' }, encoding: 'utf8', timeout: mode === 'install' ? 265000 : 145000, maxBuffer: 1024 * 1024 });
      // Child diagnostics are already private. Do not copy stdout, stderr or external errors into the result.
      assert(!child.error && child.status === 0, `RECEPTION_${mode.toUpperCase()}_FAILED`);
    }
    const installBytes = await readFile(installPath), observeBytes = await readFile(observePath);
    const acceptance = bindReception(manifest, JSON.parse(installBytes), JSON.parse(observeBytes), { manifestSha256: digest(manifestBytes), installSha256: digest(installBytes), observeSha256: digest(observeBytes), packageManifests, expectedCore: core, expectedProfile: profile });
    assert(digest(await readFile(manifestPath)) === digest(manifestBytes), 'RECEPTION_MANIFEST_CHANGED');
    for (const row of artifacts) assert(digest(await readFile(row.file)) === row.sha256, 'RECEPTION_ARCHIVE_CHANGED');
    await writeFile(join(evidence, 'ACCEPTANCE.json'), JSON.stringify(acceptance, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    Object.assign(result, { status: acceptance.status, success: true, acceptance: 'ACCEPTANCE.json', installSha256: digest(installBytes), observeSha256: digest(observeBytes) });
    return result;
  } catch (error) {
    result.status = 'failed'; result.failure = String(error.message).match(/^RECEPTION_[A-Z_]+/)?.[0] ?? 'RECEPTION_FAILED';
    throw Error(result.failure);
  } finally {
    await writeFile(resultFile, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: Object.fromEntries(['manifest', 'core', 'pnpm', 'home', 'evidence'].map(name => [name, { type: 'string' }])) });
    const result = await receiveDelivery(values);
    console.log(JSON.stringify({ success: result.success, status: result.status, artifactSetSha256: result.artifactSetSha256 }));
  } catch (error) {
    console.error(String(error.message).match(/^RECEPTION_[A-Z_]+/)?.[0] ?? 'RECEPTION_INPUT_INVALID');
    process.exitCode = 1;
  }
}
