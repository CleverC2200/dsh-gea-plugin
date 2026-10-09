import { artifactSetSha256 } from './contract.mjs';
/** Install only three ordinary artifacts in a new explicit profile, then observe in a clean child. */
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { isAbsolute, join, dirname, basename, relative, sep } from 'node:path';
import { readFile, writeFile, mkdir, lstat, realpath, readdir } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';

const { values: v } = parseArgs({ options: Object.fromEntries(['mode', 'core', 'home', 'profile', 'pnpm', 'workbench', 'manage', 'gea', 'receipt'].map(key => [key, { type: 'string' }])) });
assert(['install', 'observe'].includes(v.mode), 'MODE_INSTALL_OR_OBSERVE_REQUIRED');
for (const key of ['core', 'home', 'profile', 'receipt']) assert(isAbsolute(v[key] ?? ''), `${key.toUpperCase()}_ABSOLUTE_REQUIRED`);
assert.equal(dirname(v.profile), join(v.home, 'profiles'), 'PROFILE_MUST_BELONG_TO_EXPLICIT_HOME');
assert(!['desktop', 'web', 'headless', 'acp', 'sdk', 'sdk-minimal'].includes(basename(v.profile)), 'CUSTOM_RECEPTION_PROFILE_REQUIRED');
const receiptDir = dirname(v.receipt), anchor = join(v.core, 'apps/cli/package.json');
const receiptLocation = relative(v.home, v.receipt);
assert(receiptLocation === '..' || receiptLocation.startsWith('..' + sep), 'RECEIPT_MUST_BE_OUTSIDE_HOME');
await mkdir(receiptDir, { recursive: true });
const expected = ['@cleverc2200/dsh-agent-workbench', 'dsh-agent-manage', '@cleverc2200/gea-dsh-prototype'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const owned = join(v.home, '.three-plugin-reception.json');
const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', DSH_HOME: v.home, DSH_TELEMETRY_DISABLED: '1', npm_config_userconfig: join(v.home, 'empty.npmrc'), npm_config_globalconfig: join(v.home, 'empty.npmrc'), npm_config_registry: 'https://registry.npmjs.org' };
const base = { at: new Date().toISOString(), mode: v.mode, core: v.core, profile: v.profile, success: false, nativeRun: false, credentialsReadOrCopied: false, modelTasks: 0, businessQueries: 0 };
await writeFile(v.receipt, JSON.stringify({ ...base, pending: true }) + '\n', { mode: 0o600, flag: 'wx' });
try {
  const coreManifest = await readJson(anchor);
  assert.equal(coreManifest.version, '0.2.1-alpha.1', 'UNSUPPORTED_CORE_VERSION');
  base.coreHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: v.core, encoding: 'utf8' }).trim();
  assert.equal(base.coreHead, '5badb15009ae1756c3afe0ae0cef1faafc290ccc', 'UNSUPPORTED_CORE_HEAD');
  if (v.mode === 'install') {
    for (const key of ['pnpm', 'workbench', 'manage', 'gea']) assert(isAbsolute(v[key] ?? ''), `${key.toUpperCase()}_ABSOLUTE_REQUIRED`);
    // Exclusive home acquisition prevents using real Home, historical profiles or an earlier failed run.
    await mkdir(v.home, { recursive: false });
    await writeFile(join(v.home, 'empty.npmrc'), '', { mode: 0o600 });
    await mkdir(join(v.home, 'profiles'));
    const artifacts = [];
    for (const [index, key] of ['workbench', 'manage', 'gea'].entries()) {
      const file = v[key];
      assert.equal((await lstat(file)).isFile(), true, 'ARTIFACT_FILE_REQUIRED');
      const names = execFileSync('tar', ['-tzf', file], { encoding: 'utf8' }).trim().split('\n');
      assert(names.every(name => name.startsWith('package/') && !name.split('/').includes('..') && !name.includes('/node_modules/')), 'UNSAFE_OR_BUNDLED_ARTIFACT');
      const manifest = JSON.parse(execFileSync('tar', ['-xOf', file, 'package/package.json'], { encoding: 'utf8' }));
      assert.equal(manifest.name, expected[index], 'ARTIFACT_IDENTITY_MISMATCH');
      assert(!/(?:link:|file:|\/Users\/|\.parallel\/)/.test(JSON.stringify(manifest)), 'MACHINE_DEPENDENCY_IN_ARTIFACT');
      artifacts.push({ file, name: manifest.name, version: manifest.version, sha256: digest(await readFile(file)) });
    }
    const boot = await import(pathToFileURL(join(v.core, 'packages/boot/app-boot/lib/index.js')));
    boot.initProfile(v.profile, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);
    await writeFile(owned, JSON.stringify({ core: v.core, profile: v.profile, artifacts }, null, 2) + '\n', { mode: 0o600 });
    // Installation child receives no inherited credential/token/proxy configuration.
    const installInput = v.receipt + '.input.json';
    await writeFile(installInput, JSON.stringify({ ...v, artifacts }), { mode: 0o600, flag: 'wx' });
    const worker = fileURLToPath(new URL('./install-worker.mjs', import.meta.url));
    const result = await child(worker, [installInput], env);
    base.installProcess = result;
    assert.equal(result.code, 0, 'OFFICIAL_INSTALL_FAILED_SEE_PRIVATE_PLUGIN_MANAGER_LOG');
    const manifest = await readJson(join(v.profile, 'package.json'));
    assert.deepEqual(Object.keys(manifest.dependencies ?? {}).sort(), [...expected].sort(), 'ONLY_THREE_DIRECT_PLUGINS_REQUIRED');
    assert(expected.every(name => manifest.dsh?.profile?.bundles?.includes(name)), 'THREE_BUNDLES_NOT_RECONCILED');
    for (const name of ['@changfenhuang/dsh-genui', 'dsh-better-sidebar']) {
      try { await lstat(join(v.profile, 'node_modules', name)); assert.fail('UNEXPECTED_PREINSTALLED_AUXILIARY'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const comparison = [];
    const inspectionRoot = v.receipt + '.artifact-inspection';
    await mkdir(inspectionRoot, { recursive: false });
    for (const [index, artifact] of artifacts.entries()) {
      const target = join(inspectionRoot, String(index));
      await mkdir(target);
      execFileSync('tar', ['-xzf', artifact.file, '-C', target]);
      const packageRoot = join(target, 'package'), installed = await realpath(join(v.profile, 'node_modules', artifact.name));
      let files = 0;
      const visit = async dir => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name), rel = relative(packageRoot, path);
          assert(!entry.isSymbolicLink(), 'ARTIFACT_SYMLINK_FORBIDDEN');
          if (entry.isDirectory()) await visit(path);
          else { assert.deepEqual(await readFile(join(installed, rel)), await readFile(path), `INSTALLED_FILE_DIFF:${artifact.name}/${rel}`); files++; }
        }
      };
      await visit(packageRoot);
      assert(relative(v.profile, installed).split(sep)[0] !== '..', 'INSTALLED_PLUGIN_OUTSIDE_PROFILE');
      comparison.push({ name: artifact.name, version: artifact.version, files, sha256: artifact.sha256, installedPath: installed, byteEqual: true });
    }
    base.artifacts = comparison;
    base.artifactSetSha256 = artifactSetSha256(artifacts);
    base.profilePnpmLockSha256 = digest(await readFile(join(v.profile, 'pnpm-lock.yaml')));
  } else {
    const owner = await readJson(owned);
    assert.equal(owner.profile, v.profile, 'PROFILE_OWNER_MISMATCH');
    assert.equal(owner.core, v.core, 'CORE_OWNER_MISMATCH');
    const runtimeInput = v.receipt + '.input.json';
    await writeFile(runtimeInput, JSON.stringify(v), { mode: 0o600, flag: 'wx' });
    const result = await child(fileURLToPath(new URL('./observe-worker.mjs', import.meta.url)), [runtimeInput], env);
    base.observationProcess = result;
    try { base.observation = await readJson(v.receipt + '.runtime.json'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; base.observationReceiptMissing = true; }
    assert.equal(result.code, 0, 'RUNTIME_RECEPTION_FAILED_SEE_PROJECTED_OBSERVATION');
  }
  base.success = true;
} catch (error) {
  // External diagnostics can contain URL tokens. Preserve only our stable uppercase failure code.
  base.failure = String(error.message).match(/[A-Z][A-Z_]{4,}/)?.[0] ?? 'RECEPTION_FAILED';
  process.exitCode = 1;
} finally {
  await writeFile(v.receipt, JSON.stringify(base, null, 2) + '\n', { mode: 0o600 });
  process.stdout.write(JSON.stringify({ success: base.success, mode: base.mode, receipt: v.receipt, failure: base.failure, checkpoint: base.observation?.checkpoint }) + '\n');
}

async function child(script, args, environment) {
  return await new Promise((resolveChild, rejectChild) => {
    const stdoutPath = v.receipt + '.private.stdout.log', stderrPath = v.receipt + '.private.stderr.log';
    const stdoutLog = createWriteStream(stdoutPath, { mode: 0o600, flags: 'wx' });
    const stderrLog = createWriteStream(stderrPath, { mode: 0o600, flags: 'wx' });
    const proc = spawn(process.execPath, [script, ...args], { cwd: receiptDir, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    // Raw startup diagnostics can contain a fresh Web token. They stay private and are excluded from delivery.
    proc.stdout.on('data', chunk => stdoutLog.write(chunk)); proc.stderr.on('data', chunk => stderrLog.write(chunk));
    let finished = false, timedOut = false, killSent = false, killTimer, finishTimer;
    const finish = async (code, signal, cleanupTimedOut = false) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout); clearTimeout(killTimer); clearTimeout(finishTimer);
      proc.stdout.destroy(); proc.stderr.destroy();
      await Promise.all([new Promise(resolveLog => stdoutLog.end(resolveLog)), new Promise(resolveLog => stderrLog.end(resolveLog))]);
      resolveChild({ code: code ?? 1, signal, timedOut, killSent, cleanupTimedOut, rawOutputPrivateOnly: true, stdoutPath, stderrPath });
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
      killTimer = setTimeout(() => {
        if (finished) return;
        killSent = proc.kill('SIGKILL');
        finishTimer = setTimeout(() => { void finish(1, 'SIGKILL', true); }, 5000);
      }, 5000);
    }, v.mode === 'install' ? 240000 : 120000);
    proc.once('error', error => { stdoutLog.end(); stderrLog.end(); clearTimeout(timeout); rejectChild(error); });
    stdoutLog.once('error', rejectChild); stderrLog.once('error', rejectChild);
    proc.once('close', (code, signal) => { void finish(code, signal); });
  });
}
