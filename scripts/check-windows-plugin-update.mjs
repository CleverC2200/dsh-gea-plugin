import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { readFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { extractAll } from "@electron/asar";
if (process.platform !== "win32") throw Error("WINDOWS_NATIVE_REQUIRED");
const root = resolve(".runtime/windows-update-native"),
  installer = join(root, "gea157.exe");
await mkdir(root, { recursive: true });
const expected = "9ab0cbdfdeb57d4227671a2b4f25f4b2793f9d3f7f5894fc6bf7cfbf39f93ba9";
const response = await fetch(
  "https://synear-gea.oss-cn-hangzhou.aliyuncs.com/client-release/raw/556e9381b39cf271b5227fdbfacbaa3584cf9cc7/desktop/GEA-Desktop-0.2.0-rc.2-win-x64-gea157-local-unsigned.exe",
  { redirect: "error" },
);
if (!response.ok) throw Error("WINDOWS_FIXED_RUNTIME_DOWNLOAD_FAILED");
const hash = createHash("sha256");
await pipeline(
  Readable.fromWeb(response.body),
  new Transform({
    transform(chunk, encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  }),
  createWriteStream(installer, { flags: "wx" }),
);
if (hash.digest("hex") !== expected) throw Error("WINDOWS_FIXED_RUNTIME_HASH_MISMATCH");
const seven = "C:/Program Files/7-Zip/7z.exe";
execFileSync(seven, ["x", installer, "-o" + join(root, "outer"), "-y"], { stdio: "ignore" });
async function find(directory, name) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.name === name) return file;
    if (entry.isDirectory()) {
      const result = await find(file, name);
      if (result) return result;
    }
  }
}
const payload = await find(join(root, "outer"), "app-64.7z");
if (!payload) throw Error("WINDOWS_FIXED_RUNTIME_PAYLOAD_MISSING");
const app = join(root, "app");
execFileSync(seven, ["x", payload, "-o" + app, "-y"], { stdio: "ignore" });
const runtime = join(root, "runtime");
extractAll(join(app, "resources/app.asar"), runtime);
const manifest = JSON.parse(await readFile(join(runtime, "package.json"), "utf8"));
if (
  manifest.dshBuildCommit !== "639ed015397290b3745d163aafe02ffee4aa3f84" ||
  manifest.dshBuildDirty !== false
)
  throw Error("WINDOWS_FIXED_CORE_MISMATCH");
const load = createRequire(join(runtime, "dsh/package.json")),
  controller = join(root, "controller.mjs");
const sdk = new Set([
  "@deepseek-ai/dsh-app-boot",
  "@deepseek-ai/dsh-atomic-write",
  "@deepseek-ai/dsh-plugin-manager/operations",
]);
await build({
  entryPoints: ["src/host/plugin-update-controller.ts"],
  outfile: controller,
  bundle: true,
  packages: "external",
  format: "esm",
  platform: "node",
  plugins: [
    {
      name: "fixed-windows-sdk",
      setup(b) {
        b.onLoad({ filter: /plugin-update-controller\.ts$/ }, async (args) => ({
          contents: (await readFile(args.path, "utf8"))
            .replace(
              "if (mutationStarted) {",
              'console.error("WINDOWS_FIXTURE_INSTALL_ERROR", error); if (mutationStarted) {',
            )
            .replace(
              /if\s*\(\s*!installed\s*\|\|/,
              'console.error("WINDOWS_FIXTURE_POSTCHECK", {manifest:after.manifest,archive,retains:retainsProfileFields(baseline,after,plan.release,archive),combination:validatePluginCombination({core:options.core,manifests:await combinationManifests(after,options.core,options.profile.dir)}),actual:await validateActualProfile(after,options.core,options.profile.dir,options.profile.installAnchor)}); if (\n                !installed ||',
            ),
          loader: "ts",
        }));
        b.onResolve({ filter: /^@deepseek-ai\// }, (args) =>
          sdk.has(args.path)
            ? { path: pathToFileURL(load.resolve(args.path)).href, external: true }
            : undefined,
        );
      },
    },
  ],
});
const executable = join(app, "GEA Desktop.exe");
let exitCode = 0;
try {
  execFileSync(
    executable,
    [
      "--expose-internals",
      "--test",
      "--test-concurrency=1",
      "tests/plugin-update-windows.native.mjs",
    ],
    {
      stdio: "inherit",
      timeout: 120000,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        GEA_WINDOWS_RUNTIME: runtime,
        GEA_WINDOWS_CONTROLLER: controller,
        GEA_PLUGIN_UPDATE_PNPM: join(app, "resources/runtime/pnpm/bin/pnpm.mjs"),
      },
    },
  );
} catch (error) {
  exitCode = error.status ?? 1;
}
await writeFile(
  join(root, "result.json"),
  JSON.stringify(
    {
      platform: process.platform,
      sourceHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      coreHead: manifest.dshBuildCommit,
      runtimeInstallerSha256: expected,
      exitCode,
      nativeUIAcceptance: false,
    },
    null,
    2,
  ) + "\n",
);
process.exitCode = exitCode;
