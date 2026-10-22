import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, cp, lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readDesktopInput, readDesktopPluginSource } from "../windows-complete-local/input.mjs";
import { macBaseline as baseline } from "./baseline.mjs";

assert.equal(process.platform, "darwin");
assert.equal(process.arch, "arm64");
const core = resolve(process.argv[2]);
const gea = resolve(process.argv[3]);
const input = await readDesktopInput(process.argv[4], process.env.GITHUB_SHA);
const pluginSource = readDesktopPluginSource(input, gea);
const output = join(process.env.RUNNER_TEMP, "gea-mac-complete");
await mkdir(output, { recursive: false });
const require = createRequire(join(core, "apps/desktop/package.json"));
const asar = createRequire(require.resolve("app-builder-lib/package.json"))("@electron/asar");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fileHash = async (path) => {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
};
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
assert.equal(git(gea, "rev-parse", "HEAD"), input.geaSourceSha);
assert.equal(git(core, "rev-parse", "HEAD"), input.seed.core.head);
const stages = [];
async function run(name, executable, args, env = process.env) {
  const started = Date.now();
  let code = 0;
  console.log(name + " started");
  const path = join(output, name + ".log");
  try {
    const log = execFileSync(executable, args, {
      env,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    await writeFile(path, log);
    console.log(name + " completed");
  } catch (error) {
    code = error.status ?? 1;
    await writeFile(path, String(error.stdout ?? "") + String(error.stderr ?? "") + error.message);
    throw error;
  } finally {
    stages.push({ name, code, seconds: (Date.now() - started) / 1000 });
    await writeFile(join(output, "stages.json"), JSON.stringify(stages, null, 2));
  }
}
async function download(url, expected, path, limit) {
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(180000),
  });
  assert.equal(response.status, 200);
  const file = await open(path, "wx");
  let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      assert.ok(size <= limit, "download size limit");
      await file.write(chunk);
    }
  } finally {
    await file.close();
  }
  assert.equal(await fileHash(path), expected, "download checksum");
}
const coreCache = fileURLToPath(
  new URL("../windows-complete-local/core-cache.mjs", import.meta.url),
);
const startedBaseline = Date.now();
const baselineReuse = JSON.parse(
  execFileSync(process.execPath, [coreCache, "verify", core, "mac-baseline"], {
    encoding: "utf8",
  }),
);
const dmg = join(core, "apps/desktop/.desktop-build/baseline/mac-arm64.dmg");
if (!baselineReuse.hit) {
  await mkdir(join(dmg, ".."), { recursive: true });
  await download(baseline.url, baseline.sha256, dmg, 600 * 1024 * 1024);
  execFileSync(process.execPath, [coreCache, "seal", core, "mac-baseline"], {
    stdio: "inherit",
  });
}
stages.push({
  name: "prepare-baseline",
  code: 0,
  seconds: (Date.now() - startedBaseline) / 1000,
});
await writeFile(join(output, "baseline-reuse.json"), JSON.stringify(baselineReuse, null, 2));
const mount = join(output, "baseline-mounted");
await mkdir(mount);
const app = join(output, "GEA Desktop.app");
await run("baseline-attach", "/usr/bin/hdiutil", [
  "attach",
  "-readonly",
  "-nobrowse",
  "-mountpoint",
  mount,
  dmg,
]);
try {
  await run("baseline-signature", "/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    join(mount, "GEA Desktop.app"),
  ]);
  await run("baseline-copy", "/usr/bin/ditto", [join(mount, "GEA Desktop.app"), app]);
} finally {
  await run("baseline-detach", "/usr/bin/hdiutil", ["detach", mount]);
}
const resources = join(app, "Contents/Resources");
const archive = join(resources, "app.asar");
const seed = join(resources, "company-seed");
const originalSeed = JSON.parse(await readFile(join(seed, "manifest.json"), "utf8"));
assert.equal(originalSeed.core.head, input.seed.core.head);
for (const row of originalSeed.core.artifacts) {
  assert.equal(hash(asar.extractFile(archive, row.path)), row.sha256);
  if (row.path !== "package.json")
    assert.equal(
      row.sha256,
      input.seed.core.artifacts.find((expected) => expected.path === row.path)?.sha256,
    );
}
const originalMetadata = JSON.parse(asar.extractFile(archive, "package.json"));
assert.equal(originalMetadata.dshBuildDirty, false);
assert.equal(originalMetadata.dshMandatoryUpdatePolicy, undefined);
const framework = join(
  app,
  "Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework",
);
const frameworkHash = await fileHash(framework);
const extracted = join(output, "asar-input");
asar.extractAll(archive, extracted);
const names = asar.listPackage(archive).map((name) => name.replace(/^\//, ""));
const unpackDirs = [];
const unpackFiles = [];
for (const name of names) {
  const entry = asar.statFile(archive, name, false);
  if (!entry.unpacked) continue;
  if (!entry.files && !entry.link)
    await chmod(
      join(extracted, name),
      (await lstat(join(archive + ".unpacked", name))).mode & 0o777,
    );
  if (entry.files) {
    if (!unpackDirs.some((parent) => name.startsWith(parent + "/"))) unpackDirs.push(name);
  } else if (!unpackDirs.some((parent) => name.startsWith(parent + "/"))) unpackFiles.push(name);
}
const wrappers = [
  "official-main.cjs",
  "company-bootstrap.mjs",
  "company-gea-refresh.mjs",
  "company-archives.mjs",
  "legacy-gea-cleanup.mjs",
  "plugin-storage.mjs",
  "plugin-store-lock.mjs",
  "physical-fs.mjs",
];
for (const name of wrappers) await cp(join(gea, "desktop", name), join(extracted, name));
await writeFile(
  join(extracted, "package.json"),
  JSON.stringify(
    {
      ...originalMetadata,
      version: input.desktopVersion,
      geaBrandingCommit: input.geaSourceSha,
      dshLocalTestBuild: true,
      dshLocalPackaging: "company-core-full-three-plugin-ad-hoc",
    },
    null,
    2,
  ) + "\n",
);
const escape = (value) => value.replace(/[*?[\]{}()!+@\\]/g, "\\$&");
function pattern(paths) {
  if (!paths.length) return undefined;
  const groups = new Map();
  for (const path of paths) {
    const at = path.indexOf("/");
    const prefix = at < 0 ? path : path.slice(0, at + 1);
    const suffix = at < 0 ? "" : path.slice(at + 1);
    if (!groups.has(prefix)) groups.set(prefix, []);
    groups.get(prefix).push(suffix);
  }
  const choices = [...groups].map(
    ([prefix, suffixes]) => escape(prefix) + (suffixes[0] === "" ? "" : pattern(suffixes)),
  );
  return choices.length === 1 ? choices[0] : "{" + choices.join(",") + "}";
}
const next = join(output, "new-app.asar");
await asar.createPackageWithOptions(extracted, next, {
  unpackDir: pattern(unpackDirs),
  unpack: unpackFiles.length ? escape(extracted) + "/" + pattern(unpackFiles) : undefined,
});
for (const name of names) {
  const before = asar.statFile(archive, name, false);
  assert.equal(Boolean(asar.statFile(next, name, false).unpacked), Boolean(before.unpacked), name);
  if (!before.files && !before.link && name !== "package.json" && !wrappers.includes(name))
    assert.equal(hash(asar.extractFile(next, name)), hash(asar.extractFile(archive, name)), name);
}
await rename(next, archive);
asar.uncache(archive);
await rm(archive + ".unpacked", { recursive: true, force: true });
await rename(next + ".unpacked", archive + ".unpacked");
const coreProof = structuredClone(originalSeed.core);
for (const row of coreProof.artifacts) row.sha256 = hash(asar.extractFile(archive, row.path));
const packages = [];
await mkdir(join(output, "packages"));
for (const row of input.seed.packages) {
  const path = join(output, "packages", new URL(row.url).pathname.split("/").at(-1));
  await download(row.url, row.sha256, path, 32 * 1024 * 1024);
  packages.push({ ...row, path });
}
await rm(seed, { recursive: true });
const seedInput = join(output, "seed-input.json");
await writeFile(
  seedInput,
  JSON.stringify({ packages, core: coreProof, source: input.seed.source }),
);
await run("prepare-company-seed", process.execPath, [
  "--expose-internals",
  join(gea, "desktop/prepare-company-seed.mjs"),
  extracted,
  join(resources, "runtime"),
  seed,
  join(output, "seed-home"),
  seedInput,
]);
const headerHash = hash(Buffer.from(asar.getRawHeader(archive).headerString));
execFileSync("/usr/bin/python3", [
  "-c",
  'import plistlib,sys; p=sys.argv[1]; d=plistlib.load(open(p,"rb")); d["CFBundleShortVersionString"]=sys.argv[2]; d["CFBundleVersion"]=sys.argv[2]; d["ElectronAsarIntegrity"]["Resources/app.asar"]={"algorithm":"SHA256","hash":sys.argv[3]}; plistlib.dump(d,open(p,"wb"))',
  join(app, "Contents/Info.plist"),
  input.desktopVersion,
  headerHash,
]);
await run("ad-hoc-sign", "/usr/bin/codesign", [
  "--force",
  "--sign",
  "-",
  "--preserve-metadata=entitlements,flags",
  "--timestamp=none",
  app,
]);
await run("signature-verify", "/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
const artifactName = "GEA-Desktop-" + input.desktopVersion + "-mac-arm64-local.dmg";
const config = {
  appId: "com.cleverc2200.gea.desktop",
  productName: "GEA Desktop",
  artifactName,
  extraMetadata: { version: input.desktopVersion },
  directories: { output: join(output, "artifacts") },
  mac: {
    icon: join(gea, "desktop/build/icon.png"),
    identity: null,
    forceCodeSigning: false,
    hardenedRuntime: false,
    notarize: false,
    target: ["dmg"],
  },
  dmg: { sign: false, writeUpdateInfo: false },
  publish: null,
};
const configPath = join(output, "prepackaged-builder.cjs");
await writeFile(configPath, "module.exports=" + JSON.stringify(config) + ";\n");
await run("package-dmg", process.execPath, [
  require.resolve("electron-builder/cli.js"),
  "--projectDir",
  join(core, "apps/desktop"),
  "--config",
  configPath,
  "--prepackaged",
  app,
  "--mac",
  "dmg",
  "--arm64",
  "--publish",
  "never",
]);
const artifact = join(output, "artifacts", artifactName);
await run("dmg-verify", "/usr/bin/hdiutil", ["verify", artifact]);
const finalMount = join(output, "mounted-dmg");
await mkdir(finalMount);
await run("dmg-attach", "/usr/bin/hdiutil", [
  "attach",
  "-readonly",
  "-nobrowse",
  "-mountpoint",
  finalMount,
  artifact,
]);
try {
  const mounted = join(finalMount, "GEA Desktop.app");
  const mountedResources = join(mounted, "Contents/Resources");
  const mountedArchive = join(mountedResources, "app.asar");
  const executable = join(mounted, "Contents/MacOS/GEA Desktop");
  assert.equal(await fileHash(mountedArchive), await fileHash(archive));
  assert.equal(
    await fileHash(
      join(
        mounted,
        "Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework",
      ),
    ),
    frameworkHash,
  );
  await run("mounted-signature", "/usr/bin/codesign", ["--verify", "--deep", "--strict", mounted]);
  const home = join(output, "fresh-install");
  await run(
    "fresh-install",
    executable,
    [
      "--expose-internals",
      join(mountedArchive, "company-bootstrap.mjs"),
      mountedArchive,
      join(mountedResources, "runtime"),
      join(mountedResources, "company-seed"),
    ],
    { ...process.env, ELECTRON_RUN_AS_NODE: "1", DSH_HOME: home },
  );
  const receipt = JSON.parse(
    await readFile(join(home, "profiles/desktop/gea/bootstrap/receipt.json"), "utf8"),
  );
  assert.equal(receipt.status, "installed");
  assert.equal(receipt.packages.length, 3);
  await writeFile(join(output, "first-install-receipt.json"), JSON.stringify(receipt, null, 2));
  const smoke = join(output, "runtime-smoke.mts");
  await writeFile(
    smoke,
    `import { verifyDesktopRuntime } from ${JSON.stringify(pathToFileURL(join(core, "apps/desktop/src/runtime-tree.ts")).href)};\nimport { smokePreparedRuntime } from ${JSON.stringify(pathToFileURL(join(core, "apps/desktop/scripts/smoke-prepared-runtime.ts")).href)};\nconst descriptor=await verifyDesktopRuntime(${JSON.stringify(join(extracted, "dsh"))},'0.2.0-rc.2',{platform:'darwin',arch:'arm64'});\nawait smokePreparedRuntime(${JSON.stringify(join(mountedArchive, "dsh"))},${JSON.stringify(executable)},${JSON.stringify(join(mountedResources, "runtime"))},descriptor);\n`,
  );
  await run("runtime-smoke", process.execPath, ["--import", require.resolve("tsx"), smoke]);
} finally {
  await run("dmg-detach", "/usr/bin/hdiutil", ["detach", finalMount]);
}
assert.equal(git(gea, "status", "--porcelain"), "");
assert.equal(git(core, "status", "--porcelain"), "");
await writeFile(
  join(output, "result.json"),
  JSON.stringify(
    {
      status: "packaged-and-runtime-smoke-passed",
      coreSha: input.seed.core.head,
      geaSha: input.geaSourceSha,
      geaPluginSourceSha: pluginSource.head,
      desktopVersion: input.desktopVersion,
      artifact,
      sha256: await fileHash(artifact),
      baseline,
      baselineReuse,
      stages,
      signing: "ad-hoc; not Apple notarized",
      published: false,
      actualNativeUpdateAcceptance: false,
    },
    null,
    2,
  ),
);
console.log(JSON.stringify({ status: "packaged-and-runtime-smoke-passed", artifact }));
