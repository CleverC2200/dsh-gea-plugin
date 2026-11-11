import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, writeFile, symlink, copyFile, stat } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { prepareDesktopRelease } from "../desktop-release.mjs";
import {
  adaptCompanyMacFactory,
  companyMacDownloadPrefix,
  companyMacUpdateUrl,
  finalizeCompanyMacUpdateManifest,
} from "./signing.mjs";

const core = resolve(process.argv[2]);
const gea = resolve(process.argv[3]);
const candidate = process.argv.includes("--candidate");
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const geaSha = git(gea, "rev-parse", "HEAD");
const {
  readDesktopInput,
  readDesktopPluginSource,
  coreArtifactPaths,
  verifyPersonalMemoryArchive,
} = await import(pathToFileURL(join(gea, "scripts/windows-complete-local/input.mjs")));
const input = await readDesktopInput(process.argv[4], geaSha);
const plugin = readDesktopPluginSource(input, gea);
assert.equal(git(core, "rev-parse", "HEAD"), input.seed.core.head);
assert.equal(git(core, "status", "--porcelain"), "");
assert.equal(git(gea, "status", "--porcelain"), "");
const tag = "desktop-v" + input.desktopVersion;
if (candidate) {
  assert.equal(
    git(gea, "ls-remote", "https://github.com/CleverC2200/dsh-gea-plugin.git", "refs/tags/" + tag),
    "",
    "CANDIDATE_VERSION_ALREADY_PUBLISHED",
  );
} else {
  const main = git(
    gea,
    "ls-remote",
    "https://github.com/CleverC2200/dsh-gea-plugin.git",
    "refs/heads/main",
  ).split(/\s+/)[0];
  git(gea, "merge-base", "--is-ancestor", geaSha, main);
  assert.equal(git(gea, "cat-file", "-t", tag), "tag");
  assert.equal(git(gea, "rev-parse", tag + "^{commit}"), geaSha);
  const reservation = JSON.parse(
    git(gea, "for-each-ref", "--format=%(contents)", "refs/tags/" + tag),
  );
  assert.equal(reservation.releaseSourceSha, geaSha);
  assert.equal(reservation.desktopVersion, input.desktopVersion);
  assert.deepEqual(reservation.core, {
    head: input.seed.core.head,
    version: input.seed.core.version,
  });
  const identities = (packages) =>
    packages
      .map(({ name, version, sha256 }) => ({ name, version, sha256 }))
      .sort((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(identities(reservation.packages), identities(input.seed.packages));
}
if (process.argv.includes("--plan")) {
  console.log(
    JSON.stringify({
      status: candidate ? "local-candidate-input-validated" : "reserved-input-validated",
      tag,
      core: input.seed.core.head,
      gea: geaSha,
    }),
  );
  process.exit(0);
}
assert.ok(process.env.CSC_KEYCHAIN, "USE_COMPANY_MAC_SIGNING_ENTRY");
assert.equal(process.platform, "darwin");
assert.equal(process.arch, "arm64");
const output = join(process.env.RUNNER_TEMP, "gea-mac-source");
await mkdir(output);
const desktop = join(core, "apps/desktop");
const target = join(desktop, ".desktop-build/targets/mac-arm64");
const env = {
  ...process.env,
  DSH_DESKTOP_BUILD_VERSION: input.desktopVersion,
  DSH_DESKTOP_BUILD_COMMIT: input.seed.core.head,
  DSH_DESKTOP_APP_ID: "com.cleverc2200.gea.desktop",
  DSH_DESKTOP_TARGET_PLATFORM: "darwin",
  DSH_DESKTOP_TARGET_ARCH: "arm64",
};
const stages = [];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function fileHash(path, algorithm = "sha256", encoding = "hex") {
  const digest = createHash(algorithm);
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest(encoding);
}
async function run(name, file, args, cwd = core, overrides = {}) {
  const log = join(output, name + ".log");
  const fd = await open(log, "wx", 0o600);
  const started = Date.now();
  console.log(name + " started");
  const code = await new Promise((done, reject) => {
    const child = spawn(file, args, {
      cwd,
      env: { ...env, ...overrides },
      stdio: ["ignore", fd.fd, fd.fd],
    });
    child.once("error", reject);
    child.once("close", done);
  });
  await fd.close();
  stages.push({ name, code, seconds: (Date.now() - started) / 1000 });
  await writeFile(join(output, "stages.json"), JSON.stringify(stages, null, 2));
  assert.equal(code, 0, name + " failed; see " + log);
  console.log(name + " passed");
}
const pnpm = (name, args, cwd) => run(name, "corepack", ["pnpm", ...args], cwd);
await writeFile(join(output, "fixed-input.json"), JSON.stringify(input, null, 2));
await pnpm("build-official", ["run", "build:official"]);
await pnpm("pack-dsh", [
  "run",
  "release:pack",
  "--family",
  "dsh",
  "--out",
  join(target, "packed/dsh"),
]);
await pnpm("pack-host", [
  "--dir",
  "apps/desktop-host",
  "pack",
  "--pack-destination",
  join(target, "packed/dsh"),
]);
await pnpm("pack-vendor", [
  "run",
  "release:pack",
  "--family",
  "vendor",
  "--out",
  join(target, "packed/vendor"),
]);
await pnpm("build-native-ts", ["--dir", "native/system", "run", "build:ts"]);
await pnpm("pack-native", [
  "--dir",
  "native/system/packages/entry",
  "pack",
  "--pack-destination",
  join(target, "packed/landlock"),
]);
for (const step of ["runtime", "packages"])
  await pnpm("prepare-" + step, ["run", "prepare:" + step], desktop);
const preparationPath = join(desktop, "scripts/prepare-dsh.ts");
await writeFile(
  join(output, "preparation.json"),
  JSON.stringify(
    {
      core: input.seed.core.head,
      sourceSha256: hash(await readFile(preparationPath)),
      signing: "Developer ID native runtime before integrity sealing; original Core preparation",
    },
    null,
    2,
  ),
);
await pnpm("prepare-dsh", ["exec", "tsx", preparationPath], desktop);
const artifacts = [];
for (const path of coreArtifactPaths)
  artifacts.push({
    path,
    sha256: await fileHash(path.startsWith("dsh/") ? join(target, path) : join(desktop, path)),
  });
const seed = {
  ...input.seed,
  core: { ...input.seed.core, artifacts },
  packages: [],
};
await mkdir(join(output, "packages"));
for (const row of input.seed.packages) {
  const response = await fetch(row.url, {
    redirect: "error",
    signal: AbortSignal.timeout(180000),
  });
  assert.equal(response.status, 200);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    assert(size <= 32 * 1024 * 1024);
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  assert.equal(hash(bytes), row.sha256);
  const path = join(output, "packages", new URL(row.url).pathname.split("/").at(-1));
  await writeFile(path, bytes, { flag: "wx" });
  const manifest = JSON.parse(
    execFileSync("tar", ["-xOf", path, "package/package.json"], {
      encoding: "utf8",
    }),
  );
  assert.equal(manifest.name, row.name);
  assert.equal(manifest.version, row.version);
  verifyPersonalMemoryArchive(path, row, input);
  seed.packages.push({ ...row, path });
}
const seedInput = join(output, "seed-input.json");
await writeFile(seedInput, JSON.stringify(seed));
const seedRoot = join(output, "seed-root");
await mkdir(seedRoot);
await symlink(join(target, "dsh"), join(seedRoot, "dsh"));
const companySeed = join(output, "company-seed");
await run(
  "prepare-company-seed",
  process.execPath,
  [
    join(gea, "desktop/prepare-company-seed.mjs"),
    seedRoot,
    join(target, "runtime"),
    companySeed,
    join(output, "seed-home"),
    seedInput,
  ],
  desktop,
);
function relocate(source, original) {
  return source
    .replace(
      /\b(from\s+|import\s*\()(['"])(\.{1,2}\/[^'"\n]+)\2/g,
      (_, prefix, quote, specifier) =>
        `${prefix}${quote}${pathToFileURL(resolve(dirname(original), specifier)).href}${quote}`,
    )
    .replaceAll("import.meta.url", JSON.stringify(pathToFileURL(original).href));
}
const factoryPath = join(desktop, "scripts/electron-builder-config.mjs");
const { prepareOfficialGeaMain } = await import(
  pathToFileURL(join(gea, "desktop/official-branding.mjs"))
);
const brandedMain = await prepareOfficialGeaMain(desktop, output);
let factory = relocate(await readFile(factoryPath, "utf8"), factoryPath);
factory = adaptCompanyMacFactory(factory);
await writeFile(join(output, "builder-factory.mjs"), factory);
const config = `import {createElectronBuilderConfig} from './builder-factory.mjs';
import {officialGeaBranding} from ${JSON.stringify(pathToFileURL(join(gea, "desktop/official-branding.mjs")).href)};
import {configureSignedCompanyMac} from ${JSON.stringify(new URL("./signing.mjs", import.meta.url).href)};
let config=officialGeaBranding(createElectronBuilderConfig(process.env),{companySeed:${JSON.stringify(companySeed)},brandedMain:${JSON.stringify(brandedMain)}});
config=configureSignedCompanyMac(config,${JSON.stringify(geaSha)});
export default config;
`;
const configPath = join(output, "builder.mjs");
await writeFile(configPath, config);
await pnpm(
  "package-dmg-zip",
  [
    "exec",
    "electron-builder",
    "--config",
    configPath,
    "--mac",
    "dmg",
    "zip",
    "--arm64",
    "--publish",
    "never",
  ],
  desktop,
);
const app = join(target, "artifacts/mac-arm64/Synear GEA.app");
const resources = join(app, "Contents/Resources");
const archive = join(resources, "app.asar");
const executable = join(app, "Contents/MacOS/Synear GEA");
const require = createRequire(join(desktop, "package.json"));
const asar = createRequire(require.resolve("app-builder-lib/package.json"))("@electron/asar");
const metadata = JSON.parse(asar.extractFile(archive, "package.json"));
assert.equal(metadata.version, input.desktopVersion);
assert.equal(metadata.dshBuildCommit, input.seed.core.head);
assert.equal(metadata.geaBrandingCommit, geaSha);
assert.equal(metadata.dshBuildDirty, false);
const packagedSeed = JSON.parse(
  await readFile(join(resources, "company-seed/manifest.json"), "utf8"),
);
assert.equal(packagedSeed.core.head, input.seed.core.head);
for (const row of packagedSeed.core.artifacts)
  assert.equal(hash(asar.extractFile(archive, row.path)), row.sha256);
const smokePath = join(desktop, "scripts/smoke-packaged-runtime.ts");
await writeFile(
  join(output, "smoke-gea.mts"),
  relocate(
    (await readFile(smokePath, "utf8"))
      .replaceAll("DeepSeek Harness.app", "Synear GEA.app")
      .replaceAll("'DeepSeek Harness'", "'Synear GEA'"),
    smokePath,
  ),
);
await pnpm("runtime-smoke", ["exec", "tsx", join(output, "smoke-gea.mts")], desktop);
await run("signature-verify", "/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
assert.equal(metadata.dshMandatoryUpdatePolicy, undefined);
const { verifyMacOSAppUpdateConfig } = await import(
  pathToFileURL(join(desktop, "scripts/macos-app-update-config.mjs"))
);
await verifyMacOSAppUpdateConfig(app, { publicUrl: companyMacUpdateUrl });
const home = join(output, "fresh-install");
await run(
  "first-install",
  "/usr/bin/sandbox-exec",
  [
    "-p",
    "(version 1)(allow default)(deny network*)",
    executable,
    "--expose-internals",
    join(archive, "company-bootstrap.mjs"),
    archive,
    join(resources, "runtime"),
    join(resources, "company-seed"),
  ],
  desktop,
  { ELECTRON_RUN_AS_NODE: "1", DSH_HOME: home },
);
const receipt = JSON.parse(
  await readFile(join(home, "profiles/desktop/gea/bootstrap/receipt.json"), "utf8"),
);
assert.equal(receipt.status, "installed");
assert.deepEqual(
  receipt.packages.map(({ name, version }) => ({ name, version })),
  input.seed.packages.map(({ name, version }) => ({ name, version })),
);
await writeFile(join(output, "first-install-receipt.json"), JSON.stringify(receipt, null, 2));
const name = "Synear-GEA-" + input.desktopVersion + "-mac-arm64-signed.dmg";
const sourceArtifact = join(target, "artifacts", name);
await run("dmg-verify", "/usr/bin/hdiutil", ["verify", sourceArtifact]);
const { resolveMacOSSigningEnvironment } = await import(
  pathToFileURL(join(desktop, "scripts/desktop-release-environment.mjs"))
);
const { verifyMacOSNotarizedApplication, verifyMacOSDiskImage } = await import(
  pathToFileURL(join(desktop, "scripts/verify-macos-signature.mjs"))
);
const expected = resolveMacOSSigningEnvironment(env);
verifyMacOSNotarizedApplication(app, expected);
verifyMacOSDiskImage(sourceArtifact, expected);
const zipName = `Synear-GEA-${input.desktopVersion}-mac-arm64-signed.zip`;
const updatePath = join(target, "artifacts/nightly-mac.yml");
const yaml = require("js-yaml");
const manifest = yaml.load(await readFile(updatePath, "utf8"));
const updates = [];
for (const filename of [zipName, name]) {
  const path = join(target, "artifacts", filename);
  updates.push({
    name: filename,
    size: (await stat(path)).size,
    sha512: await fileHash(path, "sha512", "base64"),
  });
}
const finalManifest = finalizeCompanyMacUpdateManifest(
  manifest,
  input.desktopVersion,
  updates[0],
  updates[1],
);
await writeFile(join(output, "builder-update-info.json"), JSON.stringify(manifest, null, 2));
await writeFile(updatePath, yaml.dump(finalManifest));
const files = [];
for (const filename of [name, zipName, zipName + ".blockmap", "nightly-mac.yml"]) {
  const path = join(target, "artifacts", filename);
  const size = (await stat(path)).size;
  assert.ok(size > 0);
  files.push({ name: filename, size, sha256: await fileHash(path) });
}
assert.equal(git(core, "status", "--porcelain"), "");
assert.equal(git(gea, "status", "--porcelain"), "");
for (const file of files)
  await copyFile(join(target, "artifacts", file.name), join(output, file.name));
const artifact = join(output, name);
await writeFile(
  join(output, "result.json"),
  JSON.stringify(
    {
      status: "packaged-and-runtime-smoke-passed",
      platform: "darwin-arm64",
      desktopVersion: input.desktopVersion,
      coreSha: input.seed.core.head,
      geaSha,
      geaPluginSourceSha: plugin.head,
      toolSha: process.env.GITHUB_SHA,
      inputSha256: hash(JSON.stringify(input)),
      artifact: name,
      size: (await stat(artifact)).size,
      sha256: await fileHash(artifact),
      signing: "Developer ID; Apple notarized and stapled App and DMG",
      files,
      distribution: {
        mode: "dmg-and-online-update",
        downloadPrefix: companyMacDownloadPrefix,
        automaticUpdates: true,
        updateUrl: companyMacUpdateUrl,
      },
      coreProof: packagedSeed.core,
      packages: input.seed.packages,
      firstInstall: receipt,
      stages,
      localCandidate: candidate,
      published: false,
    },
    null,
    2,
  ),
);
console.log(JSON.stringify({ status: "packaged-and-runtime-smoke-passed", artifact }));
await writeFile(
  join(output, "release-plan.json"),
  JSON.stringify(await prepareDesktopRelease(output, geaSha), null, 2),
);
