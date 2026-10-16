import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, open, readdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(process.argv[2]);
const gea = resolve(process.argv[3]);
const desktop = join(root, 'apps/desktop');
const target = join(desktop, '.desktop-build/targets/win-x64');
const output = join(target, 'gea-local');
const coreSha = '639ed015397290b3745d163aafe02ffee4aa3f84';
const geaSha = 'aba376f9ee6c24c09ca64621a75fcc898cf84c20';
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
const config = officialGeaBranding(createElectronBuilderConfig(process.env));
config.artifactName = 'GEA-Desktop-\${version}-win-\${arch}-local-unsigned.\${ext}';
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
await run('pack-dsh', ['run', 'release:pack', '--family', 'dsh', '--out', join(target, 'packed/dsh')]);
await run('pack-host', ['--dir', 'apps/desktop-host', 'pack', '--pack-destination', join(target, 'packed/dsh')]);
await run('pack-vendor', ['run', 'release:pack', '--family', 'vendor', '--out', join(target, 'packed/vendor')]);
await run('build-native-ts', ['--dir', 'native/system', 'run', 'build:ts']);
await run('pack-native', ['--dir', 'native/system/packages/entry', 'pack', '--pack-destination', join(target, 'packed/landlock')]);
await run('prepare-runtime', ['run', 'prepare:runtime'], desktop);
await run('prepare-packages', ['run', 'prepare:packages'], desktop);
await run('prepare-dsh', ['run', 'prepare:dsh'], desktop);
await run('package-windows', ['exec', 'electron-builder', '--config', join(output, 'gea-builder.mjs'), '--win', '--x64', '--publish', 'never'], desktop);
await run('smoke-windows', ['exec', 'tsx', join(output, 'smoke-gea.mts'), '--unsigned'], desktop);
const files = (await readdir(join(target, 'unsigned-artifacts'))).filter(name => name.endsWith('.exe'));
if (files.length !== 1) throw Error('EXPECTED_ONE_INSTALLER');
const artifact = join(target, 'unsigned-artifacts', files[0]);
const clean = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim();
if (clean) throw Error('CORE_SOURCE_CHANGED');
await writeFile(join(output, 'result.json'), JSON.stringify({ status: 'packaged-and-runtime-smoke-passed', coreSha, geaSha, artifact: files[0], size: (await stat(artifact)).size, sha256: createHash('sha256').update(await readFile(artifact)).digest('hex'), coreSourceUnchanged: true, windowsHost: process.platform + '-' + process.arch, unsigned: true, publish: false, freshCompanyProfileProvisioning: 'not included; preserve existing profile', pluginUpdateSubmit: 'existing win32 platform rejection retained', nativeDeviceAcceptance: 'not performed', stages }, null, 2));
