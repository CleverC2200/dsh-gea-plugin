import fs from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import cp from "node:child_process";
import { managedPackages } from "./development-repositories.mjs";
import { withBuildAdmission } from "./build-admission.mjs";

export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
export function run(file, args, cwd, options = {}) {
  const windows = process.platform === "win32" && ["corepack", "npm"].includes(file);
  const child = cp.spawnSync(windows ? file + ".cmd" : file, args, {
    cwd,
    stdio: "inherit",
    shell: windows,
    ...options,
  });
  if (child.error || child.status !== 0)
    throw Error(`DEVELOPMENT_COMMAND_FAILED:${child.status ?? child.error?.code}`);
}
export function repository(cwd = process.cwd()) {
  const path = fs.realpathSync(cwd);
  const manifest = json(join(path, "package.json"));
  const repo = Object.keys(managedPackages).find((key) => managedPackages[key] === manifest.name);
  if (!repo) throw Error("DEVELOPMENT_REPOSITORY_REQUIRED");
  if (!/^(npm|pnpm)@\d+\.\d+\.\d+$/.test(manifest.packageManager ?? ""))
    throw Error("DEVELOPMENT_TOOLCHAIN_REQUIRED");
  const [manager, version] = manifest.packageManager.split("@");
  const actual = cp
    .execFileSync(
      manager === "npm"
        ? process.platform === "win32"
          ? "npm.cmd"
          : "npm"
        : process.platform === "win32"
          ? "corepack.cmd"
          : "corepack",
      manager === "npm" ? ["--version"] : ["pnpm", "--version"],
      { cwd: path, encoding: "utf8", shell: process.platform === "win32" },
    )
    .trim();
  if (actual !== version) throw Error("DEVELOPMENT_TOOLCHAIN_MISMATCH");
  return {
    path,
    manifest,
    repo,
    manager,
    lock: manager === "npm" ? "package-lock.json" : "pnpm-lock.yaml",
  };
}
function publicFiles(target, manifest) {
  const strings = (value) =>
    typeof value === "string" ? [value] : Object.values(value ?? {}).flatMap(strings);
  const roots = [
    ...new Set(
      [...strings(manifest.exports), manifest.main, manifest.module, manifest.types]
        .filter(
          (value) =>
            typeof value === "string" && !value.startsWith("../") && !value.startsWith("/"),
        )
        .map((value) => value.replace(/^\.\//, "").split("/")[0])
        .filter((value) => value && !value.includes("*")),
    ),
  ].sort();
  const visit = (file) => {
    const path = join(target, file);
    if (!fs.existsSync(path)) return [[file, null]];
    if (fs.lstatSync(path).isDirectory())
      return fs
        .readdirSync(path)
        .filter((name) => name !== "node_modules" && !name.startsWith("."))
        .sort()
        .flatMap((name) => visit(file + "/" + name));
    return [[file, digest(fs.readFileSync(path))]];
  };
  return roots.flatMap(visit);
}
function localInputs(owner) {
  return Object.entries({
    ...owner.manifest.dependencies,
    ...owner.manifest.devDependencies,
    ...owner.manifest.optionalDependencies,
  })
    .filter(([, value]) => /^(?:file|link):/.test(value))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => {
      const target = fs.realpathSync(resolve(owner.path, value.replace(/^(?:file|link):/, "")));
      const manifest = fs.readFileSync(join(target, "package.json"));
      let head = null;
      try {
        head = cp
          .execFileSync("git", ["-C", target, "rev-parse", "HEAD"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          })
          .trim();
      } catch (error) {
        if (error.status !== 128) throw error;
      }
      return {
        name,
        target,
        head,
        manifest: digest(manifest),
        artifacts: publicFiles(target, JSON.parse(manifest)),
      };
    });
}
export function dependencyInput(owner) {
  const files = ["package.json", owner.lock, ".npmrc", "pnpm-workspace.yaml"].filter((file) =>
    fs.existsSync(join(owner.path, file)),
  );
  return {
    root: owner.path,
    files: files.map((file) => [file, digest(fs.readFileSync(join(owner.path, file)))]),
    manager: owner.manifest.packageManager,
    node: process.versions.node,
    abi: process.versions.modules,
    platform: process.platform,
    arch: process.arch,
    local: localInputs(owner),
  };
}
export function installed(owner) {
  const metadata = join(
    owner.path,
    "node_modules",
    owner.manager === "npm" ? ".package-lock.json" : ".modules.yaml",
  );
  const packages = Object.keys({
    ...owner.manifest.dependencies,
    ...owner.manifest.devDependencies,
  })
    .sort()
    .map((name) => {
      const file = join(owner.path, "node_modules", name, "package.json");
      const content = fs.readFileSync(file);
      return { name, target: fs.realpathSync(file), manifest: digest(content) };
    });
  return { metadata: digest(fs.readFileSync(metadata)), packages };
}
export async function prepareDependencies(owner) {
  if (
    fs.existsSync(join(owner.path, "tsconfig.official-paths.json")) ||
    fs.existsSync(join(owner.path, "tsconfig.official.json"))
  ) {
    const core = resolve(owner.path, "../../official-latest-standard");
    const coreHead = cp
      .execFileSync("git", ["-C", core, "rev-parse", "HEAD"], { encoding: "utf8" })
      .trim();
    const { verifyOfficialSDK } = await import(
      new URL("../../dsh-agent-manage/scripts/prepare-official-sdk.mjs", import.meta.url)
    );
    verifyOfficialSDK({ core, consumer: owner.path, coreHead });
  }
  const input = dependencyInput(owner);
  const receipt = join(owner.path, ".runtime/development/dependencies.json");
  if (fs.existsSync(receipt)) {
    const previous = json(receipt);
    try {
      if (
        JSON.stringify(previous.input) === JSON.stringify(input) &&
        JSON.stringify(previous.installed) === JSON.stringify(installed(owner))
      )
        return { status: "reused", receipt };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return withBuildAdmission({ operation: "prepare", cwd: owner.path }, async () => {
    if (owner.repo === "dsh-agent-workbench")
      run(process.execPath, ["scripts/verify-official-input.mjs"], owner.path);
    run(
      owner.manager === "npm" ? "npm" : "corepack",
      owner.manager === "npm"
        ? ["ci", "--ignore-scripts", "--prefer-offline", "--no-audit", "--no-fund"]
        : [
            "pnpm",
            "install",
            "--frozen-lockfile",
            "--prefer-offline",
            ...(owner.repo === "dsh-agent-manage" ? ["--ignore-scripts"] : []),
          ],
      owner.path,
    );
    if (JSON.stringify(dependencyInput(owner)) !== JSON.stringify(input))
      throw Error("DEVELOPMENT_INPUT_CHANGED");
    fs.mkdirSync(join(owner.path, ".runtime/development"), { recursive: true });
    fs.writeFileSync(
      receipt,
      JSON.stringify(
        {
          schemaVersion: 1,
          input,
          installed: installed(owner),
          owner: process.env.CODEX_THREAD_ID ?? owner.path,
          purpose: "development-dependencies",
          sourceHead: cp
            .execFileSync("git", ["rev-parse", "HEAD"], { cwd: owner.path, encoding: "utf8" })
            .trim(),
          retention: "regenerable-after-reader-and-input-review",
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      ) + "\n",
    );
    return { status: "prepared", receipt };
  });
}
