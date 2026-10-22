import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { release } from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { macBaseline } from "../mac-complete-local/baseline.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const git = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
async function fileHash(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}
async function plan(root, profile) {
  if (!["host", "official", "windows-runtime", "mac-baseline"].includes(profile))
    throw Error("DELIVERY_CACHE_PROFILE_INVALID");
  if (git(root, "status", "--porcelain")) throw Error("DELIVERY_CACHE_SOURCE_CHANGED");
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (!/^pnpm@\d+\.\d+\.\d+$/.test(manifest.packageManager ?? ""))
    throw Error("DELIVERY_CACHE_TOOLCHAIN_INVALID");
  const identity = {
    schemaVersion: 1,
    core: git(root, "rev-parse", "HEAD"),
    lock: await fileHash(join(root, "pnpm-lock.yaml")),
    workspace: await fileHash(join(root, "pnpm-workspace.yaml")),
    packageManager: manifest.packageManager,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    os: release(),
    image: process.env.ImageOS ?? "",
    imageVersion: process.env.ImageVersion ?? "",
    target: [
      process.env.DSH_DESKTOP_TARGET_PLATFORM ?? process.platform,
      process.env.DSH_DESKTOP_TARGET_ARCH ?? process.arch,
    ],
    profile,
    clientEnvironment: Object.fromEntries(
      Object.entries(process.env)
        .filter(([name]) => name.startsWith("DSH_CLIENT_") || name === "DSH_BUILD_CLIENT_PROFILE")
        .sort(),
    ),
    protocol: await fileHash(fileURLToPath(import.meta.url)),
  };
  if (profile === "windows-runtime") {
    identity.preparation = await fileHash(fileURLToPath(new URL("./build.mjs", import.meta.url)));
    identity.appId = process.env.DSH_DESKTOP_APP_ID ?? "";
    identity.registry = hash(process.env.DSH_DESKTOP_NPM_REGISTRY ?? "");
  }
  const cacheIdentity =
    profile === "mac-baseline" ? { schemaVersion: 1, profile, baseline: macBaseline } : identity;
  const roots =
    profile === "windows-runtime"
      ? ["electron", "runtime", "dsh"].map(
          (name) => `apps/desktop/.desktop-build/targets/win-x64/${name}`,
        )
      : profile === "mac-baseline"
        ? ["apps/desktop/.desktop-build/baseline/mac-arm64.dmg"]
        : git(root, "ls-files", "*package.json")
            .split("\n")
            .filter(
              (path) =>
                /^(?:packages|vendor|apps|native)\//.test(path) && !path.includes("/node_modules/"),
            )
            .map((path) => join(dirname(path), "lib").replaceAll("\\", "/"));
  if (profile === "official")
    roots.push("apps/web/dist", ".dsh-build/client-build-environment.json");
  const receipt = join(
    root,
    `.dsh-build/delivery-${["host", "official"].includes(profile) ? "core" : profile}-cache.json`,
  );
  return {
    identity: cacheIdentity,
    key:
      `delivery-${["host", "official"].includes(profile) ? "core" : profile}-` +
      hash(JSON.stringify(cacheIdentity)),
    roots: [...new Set(roots)].sort(),
    receipt,
  };
}
async function inventory(root, roots, profile) {
  const files = {};
  async function visit(path) {
    const full = join(root, path);
    const info = await lstat(full);
    if (info.isSymbolicLink() || (await realpath(full)) !== full)
      throw Error("DELIVERY_CACHE_ARTIFACT_TYPE");
    if (info.isDirectory()) {
      for (const name of (await readdir(full)).sort()) await visit(join(path, name));
    } else if (info.isFile() && info.nlink === 1) {
      files[path.replaceAll("\\", "/")] = {
        size: info.size,
        mode: info.mode & 0o777,
        sha256: await fileHash(full),
      };
    } else throw Error("DELIVERY_CACHE_ARTIFACT_TYPE");
  }
  for (const path of roots) {
    try {
      await lstat(join(root, path));
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    await visit(path);
  }
  const target = "apps/desktop/.desktop-build/targets/win-x64";
  const required =
    profile === "windows-runtime"
      ? [
          `${target}/electron/electron.exe`,
          `${target}/runtime/versions.json`,
          `${target}/runtime/pnpm/bin/pnpm.mjs`,
          `${target}/runtime/cli/command-manager.js`,
          `${target}/dsh/package.json`,
          `${target}/dsh/desktop-runtime.json`,
          `${target}/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js`,
        ]
      : profile === "mac-baseline"
        ? ["apps/desktop/.desktop-build/baseline/mac-arm64.dmg"]
        : [
            "apps/desktop/lib/main.js",
            "apps/cli/lib/bin.js",
            ...(profile === "official"
              ? [".dsh-build/client-build-environment.json", "apps/web/dist/index.html"]
              : []),
          ];
  for (const path of required)
    if (!files[path]?.size) throw Error("DELIVERY_CACHE_OUTPUTS_INCOMPLETE");
  if (profile === "mac-baseline" && files[required[0]].sha256 !== macBaseline.sha256)
    throw Error("DELIVERY_CACHE_BASELINE_CHANGED");
  return Object.fromEntries(Object.entries(files).sort());
}
async function main() {
  const started = Date.now();
  const [operation, directory, profile] = process.argv.slice(2);
  const root = await realpath(resolve(directory));
  const prepared = await plan(root, profile);
  const paths = [...prepared.roots.map((path) => join(root, path)), prepared.receipt];
  let hit = false;
  if (operation === "seal" || operation === "verify") {
    for (const path of [dirname(prepared.receipt), prepared.receipt]) {
      try {
        const info = await lstat(path);
        if (
          info.isSymbolicLink() ||
          (await realpath(path)) !== path ||
          (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))
        )
          throw Error("DELIVERY_CACHE_ARTIFACT_TYPE");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
  if (operation === "preflight") {
    try {
      const require = createRequire(join(root, "apps/desktop/package.json"));
      const asar = createRequire(require.resolve("app-builder-lib/package.json"))("@electron/asar");
      if (typeof asar.extractFile !== "function") throw Error();
      require.resolve("tsx");
      require.resolve("electron-builder/cli.js");
      if (profile === "official") {
        require("sharp");
        await lstat(join(dirname(process.execPath), "node_modules/corepack/dist/corepack.js"));
      }
    } catch (error) {
      throw Error("DELIVERY_TOOLS_MISSING: " + error.message);
    }
  } else if (operation === "seal") {
    const files = await inventory(root, prepared.roots, profile);
    await mkdir(dirname(prepared.receipt), { recursive: true });
    await writeFile(
      prepared.receipt,
      JSON.stringify({ identity: prepared.identity, files }) + "\n",
    );
  } else if (operation === "verify") {
    let record;
    try {
      record = JSON.parse(await readFile(prepared.receipt, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw Error("DELIVERY_CACHE_RECEIPT_INVALID");
    }
    if (record !== undefined) {
      if (!record || typeof record !== "object" || !record.identity || !record.files)
        throw Error("DELIVERY_CACHE_RECEIPT_INVALID");
      if (JSON.stringify(record.identity) !== JSON.stringify(prepared.identity))
        throw Error("DELIVERY_CACHE_IDENTITY_MISMATCH");
      if (
        JSON.stringify(record.files) !==
        JSON.stringify(await inventory(root, prepared.roots, profile))
      )
        throw Error("DELIVERY_CACHE_OUTPUT_CHANGED");
      hit = true;
    } else {
      for (const path of prepared.roots) {
        try {
          await lstat(join(root, path));
        } catch (error) {
          if (error.code === "ENOENT") continue;
          throw error;
        }
        throw Error("DELIVERY_CACHE_RECEIPT_MISSING");
      }
    }
  } else if (operation !== "plan") throw Error("DELIVERY_CACHE_OPERATION_INVALID");
  if (process.env.GITHUB_OUTPUT)
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `key=${prepared.key}\nhit=${hit}\npaths<<DELIVERY_CORE_PATHS\n${paths.join("\n")}\nDELIVERY_CORE_PATHS\n`,
    );
  console.log(
    JSON.stringify({
      operation,
      key: prepared.key,
      hit,
      paths,
      seconds: (Date.now() - started) / 1000,
    }),
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
