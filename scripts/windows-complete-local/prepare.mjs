import { compileWindowsCore } from "./compile.mjs";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const coreCache = fileURLToPath(new URL("./core-cache.mjs", import.meta.url));
export function stageRunner(root, output, stages) {
  const corepack = join(dirname(process.execPath), "node_modules/corepack/dist/corepack.js");
  return async function run(name, args, cwd = root) {
    const started = Date.now();
    const log = await open(join(output, `${name}.log`), "wx");
    console.log(`${name} started`);
    const code = await new Promise((resolvePromise, reject) => {
      const child = spawn(process.execPath, [corepack, "pnpm", ...args], {
        cwd,
        env: process.env,
        stdio: ["ignore", log.fd, log.fd],
      });
      child.on("error", reject);
      child.on("close", resolvePromise);
    });
    await log.close();
    stages.push({ name, code, seconds: (Date.now() - started) / 1000 });
    await writeFile(join(output, "stages.json"), JSON.stringify(stages, null, 2));
    if (code !== 0) {
      console.error((await readFile(join(output, `${name}.log`), "utf8")).slice(-12000));
      throw Error(`${name} failed (${code})`);
    }
    console.log(`${name} completed`);
  };
}
export async function prepareWindows(root, output, run) {
  if (process.platform !== "win32" || process.arch !== "x64")
    throw Error("Windows x64 host required");
  if (
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim() !==
    process.env.DSH_DESKTOP_BUILD_COMMIT
  )
    throw Error("SOURCE_COMMIT_MISMATCH");
  const desktop = join(root, "apps/desktop");
  const target = join(desktop, ".desktop-build/targets/win-x64");
  execFileSync(process.execPath, [coreCache, "preflight", root, "official"], { stdio: "inherit" });
  const verify = (profile) =>
    JSON.parse(
      execFileSync(process.execPath, [coreCache, "verify", root, profile], { encoding: "utf8" }),
    );
  const coreReuse = verify("official");
  const runtimeReuse = verify("windows-runtime");
  await writeFile(join(output, "core-reuse.json"), JSON.stringify(coreReuse, null, 2));
  await writeFile(join(output, "runtime-reuse.json"), JSON.stringify(runtimeReuse, null, 2));
  if (!coreReuse.hit) {
    await compileWindowsCore(run);
    execFileSync(process.execPath, [coreCache, "seal", root, "official"], {
      stdio: "inherit",
    });
  }
  if (!runtimeReuse.hit) {
    await run("pack-dsh", [
      "run",
      "release:pack",
      "--family",
      "dsh",
      "--out",
      join(target, "packed/dsh"),
    ]);
    await run("pack-host", [
      "--dir",
      "apps/desktop-host",
      "pack",
      "--pack-destination",
      join(target, "packed/dsh"),
    ]);
    await run("pack-vendor", [
      "run",
      "release:pack",
      "--family",
      "vendor",
      "--out",
      join(target, "packed/vendor"),
    ]);
    await run("pack-native", [
      "--dir",
      "native/system/packages/entry",
      "pack",
      "--pack-destination",
      join(target, "packed/landlock"),
    ]);
    await run("prepare-runtime", ["run", "prepare:runtime"], desktop);
    await run("prepare-packages", ["run", "prepare:packages"], desktop);
    await run("prepare-dsh", ["run", "prepare:dsh"], desktop);
    execFileSync(process.execPath, [coreCache, "seal", root, "windows-runtime"], {
      stdio: "inherit",
    });
  } else {
    const smoke = join(output, "reused-runtime-smoke.mts");
    await writeFile(
      smoke,
      `import { verifyDesktopRuntime } from ${JSON.stringify(pathToFileURL(join(desktop, "src/runtime-tree.ts")).href)};
import { smokePreparedRuntime } from ${JSON.stringify(pathToFileURL(join(desktop, "scripts/smoke-prepared-runtime.ts")).href)};
import { smokePrimaryRuntime } from ${JSON.stringify(pathToFileURL(join(desktop, "scripts/prepare-primary-runtime.ts")).href)};
const root = ${JSON.stringify(join(target, "dsh"))};
const runtime = ${JSON.stringify(join(target, "runtime"))};
const descriptor = await verifyDesktopRuntime(root, '0.2.0-rc.2', { platform: 'win32', arch: 'x64' });
await smokePrimaryRuntime(${JSON.stringify(join(target, "runtime/primary-runtime"))});
await smokePreparedRuntime(root, ${JSON.stringify(join(target, "electron/electron.exe"))}, runtime, descriptor);
await verifyDesktopRuntime(root, '0.2.0-rc.2', { platform: 'win32', arch: 'x64' });
`,
    );
    await run("reused-runtime-smoke", ["exec", "tsx", smoke]);
  }

  const skipped = [
    ...(coreReuse.hit ? ["build-official", "build-native-ts"] : []),
    ...(runtimeReuse.hit
      ? [
          "pack-dsh",
          "pack-host",
          "pack-vendor",
          "pack-native",
          "prepare-runtime",
          "prepare-packages",
          "prepare-dsh",
        ]
      : []),
  ];
  return { coreReuse, runtimeReuse, skipped };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (
    process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    process.env.GITHUB_REF !== `refs/heads/${process.env.GITHUB_DEFAULT_BRANCH}`
  )
    throw Error("DELIVERY_CACHE_DEFAULT_REF_REQUIRED");
  const root = resolve(process.argv[2]);
  const output = join(root, "apps/desktop/.desktop-build/targets/win-x64/gea-preparation");
  await mkdir(output, { recursive: true });
  const stages = [];
  const reuse = await prepareWindows(root, output, stageRunner(root, output, stages));
  await writeFile(
    join(output, "result.json"),
    JSON.stringify({ status: "prepared-only", executableBuilt: false, ...reuse, stages }, null, 2),
  );
}
