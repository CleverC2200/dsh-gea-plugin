import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, open, readdir, stat, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(process.argv[2]);
const gea = resolve(process.argv[3]);
const desktop = join(root, 'apps/desktop');
const target = join(desktop, '.desktop-build/targets/win-x64');
const output = join(target, 'gea-local');
const coreSha = '639ed015397290b3745d163aafe02ffee4aa3f84';
const geaSha = process.env.GEA_COMPLETE_SOURCE_SHA;
if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('Windows x64 host required');
for (const [cwd, sha] of [[root, coreSha], [gea, geaSha]]) {
  if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim() !== sha) throw Error('SOURCE_COMMIT_MISMATCH');
  if (execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }).trim()) throw Error('SOURCE_DIRTY');
}
await mkdir(output, { recursive: true });
const require = createRequire(join(desktop, 'package.json'));
const sharp = require('sharp');
const corepack = join(dirname(process.execPath), 'node_modules/corepack/dist/corepack.js');
const stages = [];
async function run(name, args, cwd = root) {
  const started = Date.now();
  const log = await open(join(output, `${name}.log`), 'wx');
  console.log(`${name} started`);
  const code = await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [corepack, 'pnpm', ...args], { cwd, env: process.env, stdio: ['ignore', log.fd, log.fd] });
    child.on('error', reject);
    child.on('close', resolvePromise);
  });
  await log.close();
  stages.push({ name, code, seconds: (Date.now() - started) / 1000 });
  await writeFile(join(output, 'stages.json'), JSON.stringify(stages, null, 2));
  if (code !== 0) {
    console.error((await readFile(join(output, `${name}.log`), 'utf8')).slice(-12000));
    throw Error(`${name} failed (${code})`);
  }
  console.log(`${name} completed`);
}
function relocate(source, original) {
  return source.replace(/\b(from\s+|import\s*\()(['"])(\.{1,2}\/[^'"\n]+)\2/g,
    (_, prefix, quote, specifier) => `${prefix}${quote}${pathToFileURL(resolve(dirname(original), specifier)).href}${quote}`)
    .replaceAll('import.meta.dirname', JSON.stringify(dirname(original)))
    .replaceAll('import.meta.url', JSON.stringify(pathToFileURL(original).href));
}
const factoryPath = join(desktop, 'scripts/electron-builder-config.mjs');
let factory = relocate(await readFile(factoryPath, 'utf8'), factoryPath);
const policy = 'const policy = resolveDesktopPolicyEnvironment(env)';
if (factory.split(policy).length !== 2) throw Error('LOCAL_CONFIG_ADAPTER_DRIFT');
factory = factory.replace(policy, 'const policy = undefined');
await writeFile(join(output, 'builder-factory.mjs'), factory);
const iconPath = join(gea, 'desktop/build/icon.png');
const icon = await sharp(iconPath).resize(256, 256).png().toBuffer();
const header = Buffer.alloc(22);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(1, 4);
header.writeUInt16LE(1, 10);
header.writeUInt16LE(32, 12);
header.writeUInt32LE(icon.length, 14);
header.writeUInt32LE(header.length, 18);
await writeFile(join(output, 'gea.ico'), Buffer.concat([header, icon]));
const installerUi = join(target, 'installer-ui');
await mkdir(installerUi, { recursive: true });
for (const asset of ['brand', 'brand-2x', 'brand-dark', 'brand-dark-2x', 'uninstaller-sidebar']) {
  const original = await sharp(join(desktop, 'installer/assets', `${asset}.png`)).metadata();
  const background = asset.includes('dark') ? '#151517' : '#ffffff';
  const foreground = asset.includes('dark') ? '#ffffff' : '#151517';
  const height = Math.floor(Math.min(original.height * 0.42, original.width * 0.20));
  const logo = await sharp(iconPath).resize(height, height).png().toBuffer();
  const svg = `<svg width="${original.width}" height="${original.height}"><rect width="100%" height="100%" fill="${background}"/><text x="50%" y="70%" text-anchor="middle" font-family="Segoe UI,Arial" font-size="${Math.floor(height * 0.30)}" fill="${foreground}">GEA Desktop</text></svg>`;
  await sharp(Buffer.from(svg)).composite([{ input: logo, left: Math.floor((original.width - height) / 2), top: Math.floor(original.height * 0.15) }]).png().toFile(join(output, `${asset}.png`));
}
const strings = (await readFile(join(desktop, 'installer/strings.nsh'), 'utf8')).replaceAll('DeepSeek Harness', 'GEA Desktop');
await writeFile(join(output, 'gea-strings.nsh'), strings);
await writeFile(join(output, 'gea-installer.nsh'), `!define INSTALLER_STRINGS_FILE "${join(output, 'gea-strings.nsh')}"\n!include "${join(desktop, 'scripts/installer.nsh')}"\n`);
const config = `import { createElectronBuilderConfig } from './builder-factory.mjs';
import { officialGeaBranding } from ${JSON.stringify(pathToFileURL(join(gea, 'desktop/official-branding.mjs')).href)};
import { execFileSync } from 'node:child_process';
const config = officialGeaBranding(createElectronBuilderConfig(process.env), { companySeed: ${JSON.stringify(join(target, 'company-seed'))} });
config.artifactName = 'GEA-Desktop-\${version}-win-\${arch}-gea157-local-unsigned.\${ext}';
config.extraMetadata = { ...config.extraMetadata, dshLocalTestBuild: true, geaBrandingCommit: '${geaSha}', dshLocalPackaging: 'official-layout-gea-windows-unsigned-no-publish' };
config.win = { ...config.win, icon: ${JSON.stringify(iconPath)}, target: [{ target: 'nsis', arch: ['x64'] }] };
config.extraResources = config.extraResources.map(item => item.to === 'tray.ico' ? { ...item, from: ${JSON.stringify(join(output, 'gea.ico'))} } : item);
config.nsis = { ...config.nsis, deleteAppDataOnUninstall: false, include: ${JSON.stringify(join(output, 'gea-installer.nsh'))} };
const prepare = config.beforeBuild;
config.beforeBuild = async (...args) => {
  const result = await prepare(...args);
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ${JSON.stringify(join(output, 'brand-bitmaps.ps1'))}]);
  return result;
};
export default config;
`;
await writeFile(join(output, 'gea-builder.mjs'), config);
await writeFile(join(output, 'brand-bitmaps.ps1'), `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
foreach ($asset in @('brand', 'brand-2x', 'brand-dark', 'brand-dark-2x', 'uninstaller-sidebar')) {
  $image = [Drawing.Image]::FromFile((Join-Path $PSScriptRoot "$asset.png"))
  try {
    $bitmap = [Drawing.Bitmap]::new($image.Width, $image.Height, [Drawing.Imaging.PixelFormat]::Format24bppRgb)
    try {
      $graphics = [Drawing.Graphics]::FromImage($bitmap)
      try { $graphics.DrawImage($image, 0, 0, $image.Width, $image.Height) } finally { $graphics.Dispose() }
      $bitmap.Save((Join-Path '${installerUi.replaceAll("'", "''")}' "$asset.bmp"), [Drawing.Imaging.ImageFormat]::Bmp)
    } finally { $bitmap.Dispose() }
  } finally { $image.Dispose() }
}
`);
const smokePath = join(desktop, 'scripts/smoke-packaged-runtime.ts');
const smoke = relocate((await readFile(smokePath, 'utf8')).replaceAll("'DeepSeek Harness.exe'", "'GEA Desktop.exe'"), smokePath);
await writeFile(join(output, 'smoke-gea.mts'), smoke);
await run('build-official', ['run', 'build:official']);
await run('pack-dsh', ['run', 'release:pack', '--family', 'dsh', '--concurrency', '6', '--out', join(target, 'packed/dsh')]);
await run('pack-host', ['--dir', 'apps/desktop-host', 'pack', '--pack-destination', join(target, 'packed/dsh')]);
await run('pack-vendor', ['run', 'release:pack', '--family', 'vendor', '--concurrency', '6', '--out', join(target, 'packed/vendor')]);
await run('build-native-ts', ['--dir', 'native/system', 'run', 'build:ts']);
await run('pack-native', ['--dir', 'native/system/packages/entry', 'pack', '--pack-destination', join(target, 'packed/landlock')]);
await run('prepare-runtime', ['run', 'prepare:runtime'], desktop);
await run('prepare-packages', ['run', 'prepare:packages'], desktop);
await run('prepare-dsh', ['run', 'prepare:dsh'], desktop);
const seedInput = JSON.parse(await readFile(join(import.meta.dirname, 'input-four.json'), 'utf8'));
for (const row of seedInput.packages) row.path = join(import.meta.dirname, 'packages', row.path);
await writeFile(join(output, 'input-four.json'), JSON.stringify(seedInput));
const seedRoot = join(target, 'seed-root');
await mkdir(seedRoot, { recursive: true });
await symlink(join(target, 'dsh'), join(seedRoot, 'dsh'), 'junction');
execFileSync(process.execPath, [join(gea, 'desktop/prepare-company-seed.mjs'), seedRoot, join(target, 'runtime'), join(target, 'company-seed'), join(target, 'seed-home'), join(output, 'input-four.json')], { env: process.env, stdio: 'inherit' });
await run('package-windows' , ['exec', 'electron-builder', '--config', join(output, 'gea-builder.mjs'), '--win', '--x64', '--publish', 'never'], desktop);
await run('smoke-windows', ['exec', 'tsx', join(output, 'smoke-gea.mts'), '--unsigned'], desktop);
const appRoot = join(target, 'unsigned-artifacts/win-unpacked/resources/app.asar');
const supportRoot = join(target, 'unsigned-artifacts/win-unpacked/resources/runtime');
const seed = join(target, 'unsigned-artifacts/win-unpacked/resources/company-seed');
const executable = join(target, 'unsigned-artifacts/win-unpacked/GEA Desktop.exe');
const cleanHome = join(target, 'offline-new-install');
execFileSync(executable, ['--expose-internals', join(appRoot, 'company-bootstrap.mjs'), appRoot, supportRoot, seed], { env: {...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: cleanHome}, stdio: 'inherit' });
const receipt = JSON.parse(await readFile(join(cleanHome, 'profiles/desktop/gea/bootstrap/receipt.json'), 'utf8'));
if (receipt.status !== 'installed' || receipt.packages.length !== 4) throw Error('FOUR_PLUGIN_NEW_INSTALL_FAILED');
await writeFile(join(output, 'first-install-receipt.json'), JSON.stringify(receipt, null, 2));

const probePackage = join(target, 'store-probe-package/package');
await mkdir(probePackage, { recursive: true });
await writeFile(join(probePackage, 'package.json'), JSON.stringify({ name: 'gea-bootstrap-store-probe', version: '1.0.0' }));
const probeArchive = join(target, 'store-probe.tgz');
execFileSync('tar', ['-czf', probeArchive, '-C', dirname(probePackage), 'package']);
const storeProbeScript = join(output, 'existing-store-smoke.mjs');
await writeFile(storeProbeScript, `import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const root=${JSON.stringify(appRoot)},home=${JSON.stringify(cleanHome)},profile=join(home,'profiles/desktop');
const {installCompanyPackages}=await import(pathToFileURL(join(root,'company-bootstrap.mjs')));
const yaml=createRequire(join(root,'dsh/package.json'))('yaml');
const modules=()=>readFile(join(profile,'node_modules/.modules.yaml'),'utf8').then(text=>yaml.parse(text));
const beforeStore=(await modules()).storeDir,patch=await readFile(join(profile,'cordis.patch.yml'));
await installCompanyPackages({root,support:${JSON.stringify(supportRoot)},home,profile,packages:[${JSON.stringify(probeArchive)}],store:${JSON.stringify(join(target,'different-store'))},offline:true});
assert.equal((await modules()).storeDir,beforeStore);
assert.deepEqual(await readFile(join(profile,'cordis.patch.yml')),patch);
const manifest=JSON.parse(await readFile(join(profile,'package.json'),'utf8'));assert(manifest.dependencies['gea-bootstrap-store-probe']);
await writeFile(${JSON.stringify(join(output,'existing-store-receipt.json'))},JSON.stringify({status:'passed',storePreserved:true,configurationPreserved:true,officialInstaller:true})+'\\n');
`);
execFileSync(executable, ['--expose-internals', storeProbeScript], { env: {...process.env, ELECTRON_RUN_AS_NODE: '1'}, stdio: 'inherit' });

const files = (await readdir(join(target, 'unsigned-artifacts'))).filter(name => name.endsWith('.exe'));
if (files.length !== 1) throw Error('EXPECTED_ONE_INSTALLER');
const artifact = join(target, 'unsigned-artifacts', files[0]);
const clean = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim();
if (clean) throw Error('CORE_SOURCE_CHANGED');
await writeFile(join(output, 'result.json'), JSON.stringify({ status: 'packaged-and-runtime-smoke-passed', coreSha, geaSha, artifact: files[0], size: (await stat(artifact)).size, sha256: createHash('sha256').update(await readFile(artifact)).digest('hex'), coreSourceUnchanged: true, windowsHost: process.platform + '-' + process.arch, unsigned: true, publish: false, freshCompanyProfileProvisioning: receipt, pluginUpdateSubmit: 'existing win32 platform rejection retained', nativeDeviceAcceptance: 'not performed', existingProfileStoreReuse: 'passed', pluginVersions: seedInput.packages.map(({name,version,sha256})=>({name,version,sha256})), stages }, null, 2));
