import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { readFile, mkdir, readdir, writeFile, cp, rename } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { extractAll, createPackageWithOptions } from "@electron/asar";
import {
  windowsNativeEntrypoints,
  windowsNativeInput,
  windowsCompanyInput,
} from "./ci-windows-update.mjs";
import { officialGeaBranding } from "../desktop/official-branding.mjs";
if (process.platform !== "win32") throw Error("WINDOWS_NATIVE_REQUIRED");
const companyDesktop = process.argv.includes("--company-desktop");
const input = companyDesktop ? windowsCompanyInput : windowsNativeInput;
const root = resolve(".runtime/windows-update-native"),
  installer = join(root, "gea157.exe");
await mkdir(root, { recursive: true });
const expected = input.installerSha256;
const response = await fetch(input.installerUrl, { redirect: "error" });
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
if (manifest.dshBuildCommit !== input.coreHead || manifest.dshBuildDirty !== false)
  throw Error("WINDOWS_FIXED_CORE_MISMATCH");
const load = createRequire(join(runtime, "dsh/package.json")),
  controller = join(root, "controller.mjs");
const sdk = new Set([
  "@deepseek-ai/dsh-app-boot",
  "@deepseek-ai/dsh-atomic-write",
  "@deepseek-ai/dsh-plugin-manager/operations",
]);
await build({
  entryPoints: [windowsNativeEntrypoints.controller],
  outfile: controller,
  bundle: true,
  packages: "external",
  format: "esm",
  platform: "node",
  plugins: [
    {
      name: "fixed-windows-sdk",
      setup(b) {
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
if (companyDesktop) {
  const config = officialGeaBranding({ files: [], extraResources: [] }, { companySeed: "fixture" });
  const companyFiles = config.files.find((file) => typeof file === "object" && file.to === ".");
  for (const name of companyFiles.filter) {
    await cp(resolve("desktop", name), join(runtime, name));
  }
  await rename(join(app, "resources/app.asar"), join(app, "resources/app.original.asar"));
  await createPackageWithOptions(runtime, join(app, "resources/app.asar"), {
    unpack: "**/*.{node,exe,dll}",
  });
  const binding = Object.fromEntries(
    await Promise.all(
      companyFiles.filter.map(async (name) => [
        name,
        createHash("sha256")
          .update(await readFile(join(runtime, name)))
          .digest("hex"),
      ]),
    ),
  );
  await writeFile(
    join(root, "candidate-company-entry.json"),
    JSON.stringify({ input, binding }, null, 2),
  );
}
let exitCode = 0;
try {
  execFileSync(
    executable,
    ["--expose-internals", "--test", "--test-concurrency=1", windowsNativeEntrypoints.fixture],
    {
      stdio: "inherit",
      timeout: 180000,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        GEA_WINDOWS_RUNTIME: runtime,
        GEA_WINDOWS_CONTROLLER: controller,
        GEA_PLUGIN_UPDATE_PNPM: join(app, "resources/runtime/pnpm/bin/pnpm.mjs"),
      },
    },
  );
  if (companyDesktop)
    execFileSync(
      process.execPath,
      ["--test", "--test-concurrency=1", "tests/company-update-windows.native.mjs"],
      {
        stdio: "inherit",
        timeout: 360000,
        env: {
          ...process.env,
          GEA_WINDOWS_APP: app,
          GEA_WINDOWS_RUNTIME: runtime,
          GEA_WINDOWS_EVIDENCE: root,
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
      acceptance: input.acceptance,
      exitCode,
      nativeUIAcceptance: false,
    },
    null,
    2,
  ) + "\n",
);
process.exitCode = exitCode;
