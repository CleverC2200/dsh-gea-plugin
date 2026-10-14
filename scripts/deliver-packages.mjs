/** Assemble ordinary plugin artifacts from explicit, already built owner inputs. */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  writeFile,
  rm,
  copyFile,
} from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import {
  supportedCores,
  coreIdentity,
  findSupportedCore,
  validSdkPeers,
} from "./supported-cores.mjs";

import { validatePluginCombination } from "../src/shared/plugin-release.mjs";
import { sdkVersion } from "./supported-cores.mjs";

const names = {
  "dsh-agent-workbench": "@cleverc2200/dsh-agent-workbench",
  "dsh-agent-manage": "dsh-agent-manage",
  "dsh-gea-plugin": "@cleverc2200/gea-dsh-prototype",
};
const auxiliary = ["@changfenhuang/dsh-genui", "dsh-better-sidebar"];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
let diagnosticDirectory;
let commandNumber = 0;
const fail = (code) => {
  throw Error(code);
};
function absolute(path) {
  if (typeof path !== "string" || !isAbsolute(path)) fail("DELIVERY_ABSOLUTE_PATH_REQUIRED");
  return resolve(path);
}
function within(root, path) {
  const name = relative(root, path);
  return name === "" || (!isAbsolute(name) && name !== ".." && !name.startsWith("../"));
}
function command(file, args, cwd) {
  const result = spawnSync(file, args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (diagnosticDirectory) {
    // Keep diagnostics without letting a matching URL or credential line reach a transcript.
    const redact = (text) =>
      String(text ?? "")
        .split("\n")
        .map((line) =>
          /token|secret|password|authorization|credential|bearer/i.test(line)
            ? "[redacted sensitive command output]"
            : line,
        )
        .join("\n");
    writeFileSync(
      join(diagnosticDirectory, `command-${++commandNumber}.log`),
      `exit=${result.status}\n${redact(result.stdout)}\n${redact(result.stderr)}\n`,
      { mode: 0o600 },
    );
  }
  if (result.error || result.status !== 0) fail("DELIVERY_COMMAND_FAILED");
  return result.stdout;
}
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const git = (path, args) => command("git", ["-C", path, ...args], path).trim();
const runtimeExport = (value) =>
  typeof value === "string" ? value : (value?.default ?? value?.import ?? value?.require);
function sdkPeers(manifest) {
  if (!validSdkPeers(manifest)) fail("DELIVERY_SDK_PEER_INCOMPATIBLE");
}
function publicFiles(manifest, files) {
  for (const key of [".", "./client"]) {
    const target = runtimeExport(manifest.exports?.[key]);
    if (typeof target !== "string" || !target.startsWith("./") || !files.has(target.slice(2)))
      fail("DELIVERY_PUBLIC_EXPORT_MISSING");
  }
  const patch = manifest.dsh?.bundle?.patch;
  if (
    typeof patch !== "string" ||
    !patch.startsWith("./") ||
    !files.has(patch.slice(2)) ||
    !manifest.dsh?.client
  )
    fail("DELIVERY_BUNDLE_DECLARATION_MISSING");
  for (const value of Object.values(manifest.exports ?? {})) {
    for (const target of typeof value === "string" ? [value] : Object.values(value ?? {})) {
      if (typeof target !== "string" || !target.startsWith("./") || target.includes("..", 2))
        fail("DELIVERY_PUBLIC_EXPORT_INVALID");
      const path = target.slice(2);
      if (path.includes("*")) {
        const [start, end] = path.split("*");
        if (![...files].some((file) => file.startsWith(start) && file.endsWith(end)))
          fail("DELIVERY_PUBLIC_EXPORT_MISSING");
      } else if (!files.has(path)) fail("DELIVERY_PUBLIC_EXPORT_MISSING");
    }
  }
}
function archive(path, expectedName, raw = false) {
  const entries = command("tar", ["-tzf", path], "/").trim().split("\n");
  if (
    entries.some(
      (file) =>
        !file.startsWith("package/") ||
        file.split("/").includes("..") ||
        file.includes("/node_modules/"),
    )
  )
    fail("DELIVERY_ARCHIVE_INVALID");
  const listing = command("tar", ["-tvzf", path], "/").trim().split("\n");
  if (listing.some((line) => !["-", "d"].includes(line[0])))
    fail("DELIVERY_ARCHIVE_LINK_FORBIDDEN");
  const manifest = JSON.parse(command("tar", ["-xOf", path, "package/package.json"], "/"));
  if (manifest.name !== expectedName) fail("DELIVERY_PACKAGE_IDENTITY_MISMATCH");
  publicFiles(manifest, new Set(entries.map((file) => file.slice(8))));
  sdkPeers(manifest);
  for (const file of entries.filter(
    (file) =>
      /\.(?:js|mjs|cjs|json|ya?ml|md|css|html)$/.test(file) &&
      file !== "package/package.json" &&
      !file.endsWith("package-lock.json") &&
      !(raw && /^package\/lib\/business\/.+\/build-inputs\.json$/.test(file)),
  )) {
    const content = command("tar", ["-xOf", path, file], "/");
    if (
      /\/Users\/|Bearer\s+[A-Za-z0-9._~-]{20,}|[?&](?:token|auth|password|secret)=/i.test(content)
    )
      fail("DELIVERY_LOCAL_STATE_IN_PACKAGE");
  }
  return manifest;
}
function builtArchive(path, manifest, outputs) {
  for (const key of [".", "./client"]) {
    const target = runtimeExport(manifest.exports[key]).slice(2);
    if (!outputs.some((output) => output.path === target)) fail("DELIVERY_BUILD_RECEIPT_INVALID");
  }
  for (const output of outputs) {
    const bytes = execFileSync("tar", ["-xOf", path, `package/${output.path}`], {
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
    });
    if (digest(bytes) !== output.sha256) fail("DELIVERY_STALE_BUILD_ARCHIVE");
  }
}

async function preflight(input, destination) {
  const supported = findSupportedCore(input.core);
  if (!supported) fail("DELIVERY_CORE_INCOMPATIBLE");
  const core = await realpath(absolute(input.core.path));
  if (
    git(core, ["rev-parse", "HEAD"]) !== input.core.head ||
    (await json(join(core, "package.json"))).version !== supported.version
  )
    fail("DELIVERY_CORE_INCOMPATIBLE");
  absolute(input.pnpm);
  await access(input.pnpm);
  if (!Array.isArray(input.repositories) || input.repositories.length !== 3)
    fail("DELIVERY_THREE_REPOSITORIES_REQUIRED");
  const owners = [];
  for (const repo of Object.keys(names)) {
    const rows = input.repositories.filter((row) => row.repo === repo);
    if (rows.length !== 1) fail("DELIVERY_THREE_REPOSITORIES_REQUIRED");
    const row = rows[0],
      path = await realpath(absolute(row.path));
    if (git(path, ["rev-parse", "HEAD"]) !== row.head) fail("DELIVERY_SOURCE_HEAD_MISMATCH");
    // Owners retain generated output changes; source edits must already be committed.
    const changes = command(
      "git",
      ["-C", path, "status", "--porcelain", "--untracked-files=all"],
      path,
    )
      .trimEnd()
      .split("\n")
      .filter(Boolean);
    if (changes.some((line) => !/^(?:lib\/|client\/)/.test(line.slice(3))))
      fail("DELIVERY_SOURCE_DIRTY");
    const manifest = await json(join(path, "package.json"));
    if (manifest.name !== names[repo]) fail("DELIVERY_PACKAGE_IDENTITY_MISMATCH");
    sdkPeers(manifest);
    const version = input.versions?.[manifest.name];
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(version))
      fail("DELIVERY_VERSION_REQUIRED");
    const lock = repo === "dsh-agent-workbench" ? "package-lock.json" : "pnpm-lock.yaml";
    const lockBytes = await readFile(join(path, lock));
    if (
      digest(lockBytes) !==
      digest(
        execFileSync("git", ["-C", path, "show", `HEAD:${lock}`], {
          stdio: ["ignore", "pipe", "pipe"],
        }),
      )
    )
      fail("DELIVERY_SOURCE_LOCK_MISMATCH");
    const buildPath = absolute(row.buildReceipt),
      build = await json(buildPath);
    if (
      build.exitCode !== 0 ||
      build.sourceHead !== row.head ||
      build.lockSha256 !== digest(lockBytes) ||
      !build.command?.file ||
      !Array.isArray(build.command.args) ||
      (await realpath(absolute(build.command.cwd))) !== path ||
      !Array.isArray(build.outputs) ||
      !build.outputs.length
    )
      fail("DELIVERY_BUILD_RECEIPT_INVALID");
    for (const output of build.outputs) {
      if (
        typeof output.path !== "string" ||
        isAbsolute(output.path) ||
        !within(path, resolve(path, output.path)) ||
        digest(await readFile(join(path, output.path))) !== output.sha256
      )
        fail("DELIVERY_BUILD_OUTPUT_MISMATCH");
    }
    if (repo !== "dsh-gea-plugin") {
      const rawManifest = archive(absolute(row.archive), manifest.name, true);
      builtArchive(row.archive, rawManifest, build.outputs);
    } else {
      // Prepare uses this same owner formatter. Validate publication metadata
      // here so a missing optional peer version cannot create a failed stage.
      const { productionManifest } = await import(
        pathToFileURL(join(path, "scripts/production-manifest.mjs"))
      );
      try {
        productionManifest(manifest, input.versions);
      } catch (error) {
        fail(
          error.message.startsWith("COMPANION_VERSION_REQUIRED:")
            ? "DELIVERY_COMPANION_VERSION_REQUIRED"
            : "DELIVERY_PRODUCTION_MANIFEST_INVALID",
        );
      }
      for (const key of [".", "./client"]) {
        const target = runtimeExport(manifest.exports?.[key]);
        if (typeof target !== "string" || !target.startsWith("./"))
          fail("DELIVERY_PUBLIC_EXPORT_MISSING");
        await access(join(path, target));
      }
      await access(join(path, manifest.dsh?.bundle?.patch ?? "MISSING_BUNDLE_PATCH"));
    }
    if (within(path, destination) || within(core, destination))
      fail("DELIVERY_DESTINATION_OVERLAP");
    owners.push({
      ...row,
      path,
      manifest,
      outputs: build.outputs,
      buildReceiptSha256: digest(await readFile(buildPath)),
      lockSha256: digest(lockBytes),
    });
  }
  try {
    await lstat(destination);
    fail("DELIVERY_DESTINATION_EXISTS");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return { core, owners };
}

async function deliver(input, destination) {
  const { core: _core, owners } = await preflight(input, destination);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const work = join(destination, "evidence");
  await mkdir(work, { mode: 0o700 });
  diagnosticDirectory = work;
  const versionsPath = join(work, "versions.json");
  await writeFile(versionsPath, JSON.stringify(input.versions, null, 2) + "\n");
  const gea = owners.find((owner) => owner.repo === "dsh-gea-plugin");
  const stage = join(work, "gea-production");
  // A rejected prepare cannot reach either curation or publication.
  command(
    process.execPath,
    [
      join(gea.path, "scripts/prepare-package.mjs"),
      "--versions",
      versionsPath,
      "--destination",
      stage,
      "--pnpm",
      input.pnpm,
    ],
    gea.path,
  );
  const pending = join(work, "pending-packages");
  await mkdir(pending);
  const packages = [];
  for (const owner of owners) {
    const receipt =
      owner.repo === "dsh-gea-plugin"
        ? JSON.parse(
            command(
              process.execPath,
              [join(gea.path, "scripts/package.mjs"), "--input", stage, "--destination", pending],
              gea.path,
            ),
          )
        : JSON.parse(
            command(
              process.execPath,
              [
                join(gea.path, "scripts/package-companion.mjs"),
                "--input",
                owner.archive,
                "--versions",
                versionsPath,
                "--destination",
                pending,
              ],
              gea.path,
            ),
          );
    const manifest = archive(receipt.artifact, owner.manifest.name);
    builtArchive(receipt.artifact, manifest, owner.outputs);
    const installGraph = {
      dependencies: manifest.dependencies,
      optionalDependencies: manifest.optionalDependencies,
      peerDependencies: manifest.peerDependencies,
      overrides: manifest.overrides,
      resolutions: manifest.resolutions,
      pnpm: manifest.pnpm,
    };
    if (
      manifest.version !== input.versions[manifest.name] ||
      manifest.devDependencies ||
      manifest.scripts ||
      /\/Users\//.test(JSON.stringify(manifest)) ||
      /(?:link:|file:|workspace:|git\+|git:\/\/|github:|gitlab:|bitbucket:|https?:\/\/[^"\s]+\.git(?:#|"))/.test(
        JSON.stringify(installGraph),
      )
    )
      fail("DELIVERY_SOURCE_DEPENDENCY_IN_PACKAGE");
    for (const name of auxiliary) {
      if (
        manifest.dependencies?.[name] ||
        (manifest.peerDependencies?.[name] &&
          manifest.peerDependenciesMeta?.[name]?.optional !== true)
      )
        fail("DELIVERY_AUXILIARY_REQUIRED");
    }
    for (const [name, range] of Object.entries(owner.manifest.peerDependencies ?? {})) {
      if (name.startsWith("@deepseek-ai/") && manifest.peerDependencies?.[name] !== range)
        fail("DELIVERY_SDK_PEER_CHANGED");
    }
    packages.push({
      repo: owner.repo,
      name: manifest.name,
      version: manifest.version,
      filename: basename(receipt.artifact),
      sha256: digest(await readFile(receipt.artifact)),
      source: {
        path: owner.path,
        head: owner.head,
        lockSha256: owner.lockSha256,
        buildReceipt: owner.buildReceipt,
        buildReceiptSha256: owner.buildReceiptSha256,
      },
      ...(owner.archive
        ? {
            sourceArchiveSha256: digest(await readFile(owner.archive)),
            excludedProvenanceFiles: receipt.excludedProvenanceFiles,
          }
        : {}),
    });
  }
  const finalManifests = packages.map((row) =>
    archive(join(pending, row.filename), row.name),
  );
  const supported = findSupportedCore(input.core);
  const sdkNames = new Set(
    finalManifests.flatMap((manifest) =>
      Object.keys(manifest.peerDependencies ?? {}).filter((name) =>
        name.startsWith("@deepseek-ai/"),
      ),
    ),
  );
  const sdk = Object.fromEntries(
    [...sdkNames].map((name) => [name, sdkVersion(supported, name)]),
  );
  if (
    validatePluginCombination({
      core: { ...coreIdentity(input.core), sdk },
      manifests: finalManifests,
    }).length
  )
    fail("DELIVERY_THREE_PACKAGE_GRAPH_MISMATCH");
  for (const file of ["package.json", "npm-shrinkwrap.json", "pnpm-lock.yaml"])
    await copyFile(join(stage, file), join(work, `gea-${file}`));
  await rm(stage, { recursive: true });
  // Publishing filenames and a success receipt is the final step, after every check.
  await rename(pending, join(destination, "packages"));
  await writeFile(
    join(destination, "SHA256SUMS"),
    packages.map((row) => `${row.sha256}  packages/${row.filename}`).join("\n") + "\n",
  );
  await writeFile(join(destination, "INSTALL.md"), installInstructions(packages));
  const manifest = {
    stage: "ordinary-three-package-delivery",
    status: "packaged",
    observedAt: new Date().toISOString(),
    core: coreIdentity(input.core),
    supportedCores: supportedCores.map(coreIdentity),
    packages,
    installation: "not-observed",
    native: "not-observed",
    businessRequests: 0,
    modelTasks: 0,
    auxiliary: "optional; only installed and enabled auxiliary capabilities are available",
  };
  await writeFile(join(destination, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(
    JSON.stringify({
      status: "packaged",
      files: packages.map((row) => `packages/${row.filename}`),
      installation: "not-observed",
      native: "not-observed",
    }),
  );
}
function installInstructions(packages) {
  return `# 三插件安装\n\n同一组三包支持以下固定官方 DSH：${supportedCores.map((core) => `${core.version} / Core ${core.head}`).join("；")}。SDK peer 仅接受这两版的精确版本 OR，由当前宿主提供同一安装实例。\n\n安装需要联网获取普通 npm 运行依赖。先核 SHA256SUMS，再打开客户端侧栏“插件”，选择“添加插件”，在包名输入框填写下面 tgz 的本地绝对路径。逐个安装，每次安装完成后选择“立即启用”。\n\n${packages.map((row, index) => `${index + 1}. packages/${row.filename}`).join("\n")}\n\n已安装同名包时沿官方升级提示操作，保留 Session、草稿与用户数据。三个主插件不强制安装 GenUI/Sidebar；未安装或未启用辅助插件时，不具备其专用工具。安装不自动登录，不发起业务或模型任务。\n\n本清单只证明打包与静态合同通过。官方 PluginManager 安装、Loader 装载、设置/预设公开结果和 Native 验收由接收回执另行记录。不要将 manifest 的 source/build 来源当成用户安装依赖。\n\n可选命令行入口为官方 dsh plugin --profile <profile> add <tgz绝对路径>，仍按上述顺序逐包操作。实际可写普通 profile 安装后捕获完整 npm 图，再沿现有 freeze-package-profile 的官方 import/frozen-install 协议验证；包自身 shrinkwrap 不代替实际 profile 锁。该开发核对不要求用户引用源码 SDK link，也不修改当前测试 profile。\n`;
}

try {
  const { values } = parseArgs({
    options: { input: { type: "string" }, destination: { type: "string" } },
  });
  const input = absolute(values.input),
    destination = absolute(values.destination);
  let request;
  try {
    request = await json(input);
  } catch {
    fail("DELIVERY_INPUT_INVALID");
  }
  await deliver(request, destination);
} catch (error) {
  // External logs and paths may contain tokens. Emit only our fixed diagnostic code.
  console.error(
    /^DELIVERY_[A-Z_]+$/.test(error.message) ? error.message : "DELIVERY_INPUT_INVALID",
  );
  process.exitCode = 1;
}
