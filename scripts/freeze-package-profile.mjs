/** Import an explicitly captured ordinary profile npm graph into the official pnpm consumer. */
import { parseArgs } from 'node:util';
import { resolve, join } from 'node:path';
import { readFile, writeFile, lstat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import YAML from 'yaml';
import { findSupportedCore } from './supported-cores.mjs';
const { values } = parseArgs({ options: { profile: { type: 'string' }, core: { type: 'string' }, lock: { type: 'string' }, receipt: { type: 'string' } } });
if (!values.profile || !values.core || !values.lock || !values.receipt) throw Error('PROFILE_LOCK_INPUTS_REQUIRED');
const profile = resolve(values.profile), core = resolve(values.core), input = await readFile(resolve(values.lock));
try {
  await lstat(join(profile, 'package-lock.json'));
  throw Error('PROFILE_OTHER_NPM_LOCK_PRESENT: preserve package-lock.json and choose one explicit lock before import');
} catch (error) { if (error.code !== 'ENOENT') throw error; }
try {
  if ((await lstat(join(profile, 'node_modules'))).isSymbolicLink()) throw Error('IMMUTABLE_SOURCE_PROFILE_INSTALL_FORBIDDEN');
} catch (error) { if (error.code !== 'ENOENT') throw error; }
const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8')), lock = JSON.parse(input);
if (lock.lockfileVersion !== 3 || JSON.stringify(Object.entries(manifest.dependencies ?? {}).sort()) !== JSON.stringify(Object.entries(lock.packages?.['']?.dependencies ?? {}).sort())) throw Error('PROFILE_NPM_LOCK_MISMATCH');
const workspace = await readFile(join(profile, 'pnpm-workspace.yaml'), 'utf8');
const configuration = YAML.parse(workspace);
if (configuration.nodeLinker !== 'hoisted' || configuration.autoInstallPeers !== false) throw Error('OFFICIAL_PROFILE_PACKAGE_PROTOCOL_REQUIRED');
const coreManifest = JSON.parse(await readFile(join(core, 'apps/cli/package.json'), 'utf8'));
if (!findSupportedCore({ version: coreManifest.version, head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: core, encoding: 'utf8' }).trim() })) throw Error('UNSUPPORTED_PACKAGE_CORE');
await writeFile(join(profile, 'npm-shrinkwrap.json'), input);
const { runProfilePnpm } = await import(pathToFileURL(join(core, 'packages/boot/plugin-manager/lib/types/operations.js')));
const command = process.execPath, args = [join(core, 'apps/desktop/node_modules/pnpm/bin/pnpm.mjs')];
const context = { profile: 'ordinary-core-packages', dir: profile, cwd: profile, installAnchor: join(core, 'apps/cli/package.json') };
const options = { execution: 'service', command, args, env: { PATH: process.env.PATH, npm_config_registry: 'https://registry.npmjs.org' }, outputBytes: 12000, activateNewBundles: false, lookupTimeoutMs: 30000, idleTimeoutMs: 60000 };
const imported = await runProfilePnpm(context, ['import'], options);
if (imported.exitCode !== 0) throw Error('PROFILE_LOCK_IMPORT_FAILED: ' + imported.output);
const frozen = await runProfilePnpm(context, ['install', '--frozen-lockfile'], options);
if (frozen.exitCode !== 0) throw Error('PROFILE_FROZEN_INSTALL_FAILED: ' + frozen.output);
const digest = value => createHash('sha256').update(value).digest('hex');
await writeFile(resolve(values.receipt), JSON.stringify({ at: new Date().toISOString(), profile, npmGraphSha256: digest(input), profilePnpmLockSha256: digest(await readFile(join(profile, 'pnpm-lock.yaml'))), imported, frozen, sdkPeersProvidedByInstallation: true, nativeRun: false }, null, 2) + '\n');
