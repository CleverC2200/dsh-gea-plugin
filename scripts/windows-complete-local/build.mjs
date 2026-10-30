import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { readDesktopInput, readDesktopPluginSource, desktopCoreHead } from "./input.mjs";
import { inspectPluginArchive } from "../../src/host/plugin-release-source.ts";
import { readFile, writeFile, mkdir, readdir, stat, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { prepareWindows, stageRunner } from "./prepare.mjs";
import {
  adaptSignedWindowsFactory,
  companyCertificateInstaller,
  resolveCompanyWindowsSigning,
  companyWindowsUpdateUrl,
} from "./signing.mjs";

const root = resolve(process.argv[2]);
const gea = resolve(process.argv[3]);
const desktop = join(root, "apps/desktop");
const target = join(desktop, ".desktop-build/targets/win-x64");
const output = join(target, "gea-local");
const signed = process.env.GEA_WINDOWS_SIGNED === "1";
const signing = signed ? resolveCompanyWindowsSigning() : undefined;
if (signing) process.env.DSH_DESKTOP_WINDOWS_CER_FILE = signing.certificateFile;
const artifactDirectory = join(target, signed ? "artifacts" : "unsigned-artifacts");
const coreSha = desktopCoreHead;
const geaSha = process.env.GITHUB_SHA;
const input = await readDesktopInput(process.argv[4], geaSha);
if (
  process.env.DSH_DESKTOP_BUILD_VERSION !== input.desktopVersion ||
  process.env.DSH_DESKTOP_BUILD_COMMIT !== coreSha ||
  process.env.DSH_DESKTOP_UNSIGNED !== "1"
)
  throw Error("DESKTOP_BUILD_ENV_MISMATCH");
process.env.GEA_COMPLETE_SOURCE_SHA = geaSha;
if (process.platform !== "win32" || process.arch !== "x64")
  throw Error("Windows x64 host required");
for (const [cwd, sha] of [
  [root, coreSha],
  [gea, geaSha],
]) {
  if (
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
    }).trim() !== sha
  )
    throw Error("SOURCE_COMMIT_MISMATCH");
  if (
    execFileSync("git", ["status", "--porcelain"], {
      cwd,
      encoding: "utf8",
    }).trim()
  )
    throw Error("SOURCE_DIRTY");
}
const pluginSource = readDesktopPluginSource(input, gea);
await mkdir(output, { recursive: true });
await writeFile(join(output, "fixed-input.json"), JSON.stringify(input, null, 2));
const require = createRequire(join(desktop, "package.json"));
const sharp = require("sharp");
const stages = [];
const run = stageRunner(root, output, stages);
function relocate(source, original) {
  return source
    .replace(
      /\b(from\s+|import\s*\()(['"])(\.{1,2}\/[^'"\n]+)\2/g,
      (_, prefix, quote, specifier) =>
        `${prefix}${quote}${pathToFileURL(resolve(dirname(original), specifier)).href}${quote}`,
    )
    .replaceAll("import.meta.dirname", JSON.stringify(dirname(original)))
    .replaceAll("import.meta.url", JSON.stringify(pathToFileURL(original).href));
}
const factoryPath = join(desktop, "scripts/electron-builder-config.mjs");
let factory = relocate(await readFile(factoryPath, "utf8"), factoryPath);
const policy = "const policy = resolveDesktopPolicyEnvironment(env)";
if (factory.split(policy).length !== 2) throw Error("LOCAL_CONFIG_ADAPTER_DRIFT");
factory = factory.replace(policy, "const policy = undefined");
if (signed) factory = adaptSignedWindowsFactory(factory, desktop);
await writeFile(join(output, "builder-factory.mjs"), factory);
const iconPath = join(gea, "desktop/build/icon.png");
const icon = await sharp(iconPath).resize(256, 256).png().toBuffer();
const header = Buffer.alloc(22);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(1, 4);
header.writeUInt16LE(1, 10);
header.writeUInt16LE(32, 12);
header.writeUInt32LE(icon.length, 14);
header.writeUInt32LE(header.length, 18);
await writeFile(join(output, "gea.ico"), Buffer.concat([header, icon]));
const installerUi = join(target, "installer-ui");
await mkdir(installerUi, { recursive: true });
for (const asset of ["brand", "brand-2x", "brand-dark", "brand-dark-2x", "uninstaller-sidebar"]) {
  const original = await sharp(join(desktop, "installer/assets", `${asset}.png`)).metadata();
  const background = asset.includes("dark") ? "#151517" : "#ffffff";
  const foreground = asset.includes("dark") ? "#ffffff" : "#151517";
  const height = Math.floor(Math.min(original.height * 0.42, original.width * 0.2));
  const logo = await sharp(iconPath).resize(height, height).png().toBuffer();
  const svg = `<svg width="${original.width}" height="${original.height}"><rect width="100%" height="100%" fill="${background}"/><text x="50%" y="70%" text-anchor="middle" font-family="Segoe UI,Arial" font-size="${Math.floor(height * 0.3)}" fill="${foreground}">GEA Desktop</text></svg>`;
  await sharp(Buffer.from(svg))
    .composite([
      {
        input: logo,
        left: Math.floor((original.width - height) / 2),
        top: Math.floor(original.height * 0.15),
      },
    ])
    .png()
    .toFile(join(output, `${asset}.png`));
}
const strings = (await readFile(join(desktop, "installer/strings.nsh"), "utf8")).replaceAll(
  "DeepSeek Harness",
  "GEA Desktop",
);
await writeFile(join(output, "gea-strings.nsh"), strings);
if (signed)
  await writeFile(
    join(output, "gea-certificate-installer.nsh"),
    companyCertificateInstaller(
      await readFile(join(desktop, "scripts/installer.nsh"), "utf8"),
      desktop,
    ),
  );
await writeFile(
  join(output, "gea-installer.nsh"),
  `!define INSTALLER_STRINGS_FILE "${join(output, "gea-strings.nsh")}"\n!include "${signed ? join(output, "gea-certificate-installer.nsh") : join(desktop, "scripts/installer.nsh")}"\n`,
);
const config = `import { createElectronBuilderConfig } from './builder-factory.mjs';
import { officialGeaBranding } from ${JSON.stringify(pathToFileURL(join(gea, "desktop/official-branding.mjs")).href)};
import { execFileSync } from 'node:child_process';
const config = officialGeaBranding(createElectronBuilderConfig(process.env), { companySeed: ${JSON.stringify(join(target, "company-seed"))} });
if (config.extraMetadata.dshMandatoryUpdatePolicy !== undefined || ${signed ? "config.publish?.[0]?.url !== " + JSON.stringify(companyWindowsUpdateUrl) : "config.publish !== null"}) throw Error('COMPANY_DESKTOP_ADAPTER_DRIFT');
config.artifactName = 'GEA-Desktop-\${version}-win-\${arch}-${signed ? "signed" : "complete-local-unsigned"}.\${ext}';
config.extraMetadata = { ...config.extraMetadata, dshLocalTestBuild: ${!signed}, geaBrandingCommit: process.env.GEA_COMPLETE_SOURCE_SHA, dshLocalPackaging: '${signed ? "official-layout-gea-windows-signed-no-publish" : "official-layout-gea-windows-unsigned-no-publish"}' };
config.win = { ...config.win, icon: ${JSON.stringify(iconPath)}, target: [{ target: 'nsis', arch: ['x64'] }] };
config.extraResources = config.extraResources.map(item => item.to === 'tray.ico' ? { ...item, from: ${JSON.stringify(join(output, "gea.ico"))} } : item);
config.nsis = { ...config.nsis, deleteAppDataOnUninstall: false, include: ${JSON.stringify(join(output, "gea-installer.nsh"))} };
const prepare = config.beforeBuild;
config.beforeBuild = async (...args) => {
  const result = await prepare(...args);
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ${JSON.stringify(join(output, "brand-bitmaps.ps1"))}]);
  return result;
};
export default config;
`;
await writeFile(join(output, "gea-builder.mjs"), config);
await writeFile(
  join(output, "brand-bitmaps.ps1"),
  `$ErrorActionPreference = 'Stop'
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
`,
);
const smokePath = join(desktop, "scripts/smoke-packaged-runtime.ts");
const smoke = relocate(
  (await readFile(smokePath, "utf8")).replaceAll("'DeepSeek Harness.exe'", "'GEA Desktop.exe'"),
  smokePath,
);
await writeFile(join(output, "smoke-gea.mts"), smoke);

const seedInput = structuredClone(input.seed);
await mkdir(join(output, "packages"));
for (const row of seedInput.packages) {
  const response = await fetch(row.url, {
    redirect: "error",
    signal: AbortSignal.timeout(120000),
  });
  if (response.status !== 200) throw Error("PACKAGE_DOWNLOAD_FAILED");
  const reader = response.body?.getReader();
  if (!reader) throw Error("PACKAGE_DOWNLOAD_BODY_MISSING");
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 32 * 1024 * 1024) throw Error("PACKAGE_DOWNLOAD_SIZE_LIMIT");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks);
  if (createHash("sha256").update(bytes).digest("hex") !== row.sha256)
    throw Error("PACKAGE_DOWNLOAD_HASH_MISMATCH");
  row.path = join(output, "packages", new URL(row.url).pathname.split("/").at(-1));
  await writeFile(row.path, bytes, { flag: "wx" });
  const manifest = await inspectPluginArchive(row.path);
  if (manifest.name !== row.name || manifest.version !== row.version)
    throw Error("PACKAGE_DOWNLOAD_IDENTITY_MISMATCH");
}
await writeFile(join(output, "input-three.json"), JSON.stringify(seedInput));
const { coreReuse, runtimeReuse, skipped } = await prepareWindows(root, output, run);

const seedStarted = Date.now();
const seedRoot = join(target, "seed-root");
await mkdir(seedRoot, { recursive: true });
await symlink(join(target, "dsh"), join(seedRoot, "dsh"), "junction");
execFileSync(
  process.execPath,
  [
    join(gea, "desktop/prepare-company-seed.mjs"),
    seedRoot,
    join(target, "runtime"),
    join(target, "company-seed"),
    join(target, "seed-home"),
    join(output, "input-three.json"),
  ],
  { env: process.env, stdio: "inherit" },
);
stages.push({ name: "prepare-company-seed", code: 0, seconds: (Date.now() - seedStarted) / 1000 });
if (signed) {
  process.env.DSH_DESKTOP_UNSIGNED = "0";
  process.env.DSH_DESKTOP_PACKAGING_RUN_DIR = join(output, "windows-signature-audit");
  await mkdir(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, { recursive: true });
}
await run(
  "package-windows",
  [
    "exec",
    "electron-builder",
    "--config",
    join(output, "gea-builder.mjs"),
    "--win",
    "--x64",
    "--publish",
    "never",
  ],
  desktop,
);
await run(
  "smoke-windows",
  ["exec", "tsx", join(output, "smoke-gea.mts"), ...(signed ? [] : ["--unsigned"])],
  desktop,
);
const appRoot = join(artifactDirectory, "win-unpacked/resources/app.asar");
const supportRoot = join(artifactDirectory, "win-unpacked/resources/runtime");
const seed = join(artifactDirectory, "win-unpacked/resources/company-seed");
const executable = join(artifactDirectory, "win-unpacked/GEA Desktop.exe");
const cleanHome = join(target, "offline-new-install");
const firstInstallStarted = Date.now();
execFileSync(
  executable,
  ["--expose-internals", join(appRoot, "company-bootstrap.mjs"), appRoot, supportRoot, seed],
  {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", DSH_HOME: cleanHome },
    stdio: "inherit",
  },
);
const receipt = JSON.parse(
  await readFile(join(cleanHome, "profiles/desktop/gea/bootstrap/receipt.json"), "utf8"),
);
if (receipt.status !== "installed" || receipt.packages.length !== 3)
  throw Error("THREE_PLUGIN_NEW_INSTALL_FAILED");
stages.push({
  name: "isolated-first-install",
  code: 0,
  seconds: (Date.now() - firstInstallStarted) / 1000,
});
await writeFile(join(output, "first-install-receipt.json"), JSON.stringify(receipt, null, 2));
execFileSync(
  executable,
  [
    "--expose-internals",
    join(gea, "scripts/windows-complete-local/legacy-bootstrap.mjs"),
    appRoot,
    supportRoot,
    seed,
    join(output, "legacy-bootstrap"),
  ],
  {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: "inherit",
  },
);
const files = (await readdir(artifactDirectory)).filter((name) => name.endsWith(".exe"));
if (files.length !== 1) throw Error("EXPECTED_ONE_INSTALLER");
const artifact = join(artifactDirectory, files[0]);
if (signed) {
  const { resolveWindowsUpdatePublisher } = await import(
    pathToFileURL(join(desktop, "scripts/windows-sign.mjs")).href
  );
  const yaml = createRequire(require.resolve("electron-updater/package.json"))("js-yaml");
  const update = yaml.load(
    await readFile(join(artifactDirectory, "win-unpacked/resources/app-update.yml"), "utf8"),
  );
  const publishers = Array.isArray(update.publisherName)
    ? update.publisherName
    : [update.publisherName];
  if (
    update.provider !== "generic" ||
    update.url !== companyWindowsUpdateUrl ||
    update.channel !== "nightly" ||
    !publishers.includes(resolveWindowsUpdatePublisher(signing.certificateFile))
  )
    throw Error("DESKTOP_SIGNED_UPDATE_CONFIG_MISMATCH");
  const metadata = yaml.load(await readFile(join(artifactDirectory, "nightly.yml"), "utf8"));
  if (
    metadata.version !== input.desktopVersion ||
    !metadata.files?.some((file) => file.url === files[0] && typeof file.sha512 === "string")
  )
    throw Error("DESKTOP_SIGNED_UPDATE_METADATA_MISMATCH");
  const { inspectWindowsRuntimeSignature } = await import(
    pathToFileURL(join(desktop, "scripts/windows-runtime-signature.mjs")).href
  );
  const signature = await inspectWindowsRuntimeSignature(artifact);
  const expectedThumbprint = new X509Certificate(
    await readFile(signing.certificateFile),
  ).fingerprint.replaceAll(":", "");
  if (
    signature.status !== "Valid" ||
    !signature.timestamped ||
    signature.thumbprint?.toUpperCase() !== expectedThumbprint
  )
    throw Error("DESKTOP_INSTALLER_SIGNATURE_INVALID");
}
for (const cwd of [root, gea])
  if (
    execFileSync("git", ["status", "--porcelain"], {
      cwd,
      encoding: "utf8",
    }).trim()
  )
    throw Error("BUILD_SOURCE_CHANGED");
const asar = createRequire(require.resolve("app-builder-lib/package.json"))("@electron/asar");
const packaged = JSON.parse(asar.extractFile(appRoot, "package.json").toString("utf8"));
if (
  packaged.dshBuildCommit !== coreSha ||
  packaged.dshBuildDirty !== false ||
  packaged.geaBrandingCommit !== geaSha ||
  packaged.version !== input.desktopVersion ||
  packaged.main !== "official-main.cjs"
)
  throw Error("DESKTOP_PACKAGED_SOURCE_MISMATCH");
const actualSeed = JSON.parse(await readFile(join(seed, "manifest.json"), "utf8"));
if (
  JSON.stringify(
    actualSeed.packages.map(({ name, version, sha256 }) => ({
      name,
      version,
      sha256,
    })),
  ) !==
  JSON.stringify(
    input.seed.packages.map(({ name, version, sha256 }) => ({
      name,
      version,
      sha256,
    })),
  )
)
  throw Error("DESKTOP_PACKAGED_SEED_MISMATCH");
const fileIdentity = async (path) => ({
  path,
  size: (await stat(path)).size,
  sha256: createHash("sha256")
    .update(await readFile(path))
    .digest("hex"),
});
await writeFile(
  join(output, "result.json"),
  JSON.stringify(
    {
      status: "packaged-and-runtime-smoke-passed",
      coreSha,
      coreReuse,
      runtimeReuse,
      cachePreflight: process.env.DSH_DELIVERY_PREFLIGHT
        ? JSON.parse(await readFile(process.env.DSH_DELIVERY_PREFLIGHT, "utf8"))
        : { reason: "unknown" },
      skipped,
      geaSha,
      geaPluginSourceSha: pluginSource.head,
      coreRoot: root,
      geaRoot: gea,
      artifact: files[0],
      size: (await stat(artifact)).size,
      sha256: createHash("sha256")
        .update(await readFile(artifact))
        .digest("hex"),
      coreSourceUnchanged: true,
      windowsHost: process.platform + "-" + process.arch,
      unsigned: !signed,
      windowsSigning: signing
        ? {
            publisher: signing.publisher,
            fingerprint: signing.fingerprint,
            updateUrl: companyWindowsUpdateUrl,
          }
        : null,
      publish: false,
      freshCompanyProfileProvisioning: receipt,
      pluginUpdateSubmit: "no real business or user update submitted",
      nativeDeviceAcceptance: "not performed",
      actualNativeUpdateAcceptance: false,
      inputSha256: createHash("sha256").update(JSON.stringify(input)).digest("hex"),
      executable: await fileIdentity(executable),
      appAsar: await fileIdentity(appRoot),
      entry: {
        path: "official-main.cjs",
        sha256: createHash("sha256")
          .update(asar.extractFile(appRoot, "official-main.cjs"))
          .digest("hex"),
      },
      packaged,
      seed: actualSeed,
      runner: {
        name: process.env.RUNNER_NAME,
        os: process.env.RUNNER_OS,
        arch: process.env.RUNNER_ARCH,
        image: process.env.ImageOS,
        imageVersion: process.env.ImageVersion,
        runId: process.env.GITHUB_RUN_ID,
        runAttempt: process.env.GITHUB_RUN_ATTEMPT,
      },
      stages,
    },
    null,
    2,
  ),
);

await writeFile(join(output, "stages.json"), JSON.stringify(stages, null, 2));
