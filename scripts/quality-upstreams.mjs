/** Prepare the two original public dependencies required by the unchanged link locks. */
import { readFile, mkdir, realpath, rename, writeFile, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { resourceDigests } from "./source-combination-integrity.mjs";
const fixed = JSON.parse(
  await readFile(new URL("./quality-upstreams.json", import.meta.url), "utf8"),
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
function run(command, args, cwd, capture = false) {
  const windows = process.platform === "win32" && command === "corepack";
  const result = spawnSync(windows ? "corepack.cmd" : command, args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
    shell: windows,
  });
  if (result.error || result.status !== 0)
    throw Error(
      "QUALITY_UPSTREAM_COMMAND_FAILED: " +
        (result.error?.message ?? result.stderr ?? result.status),
    );
  return capture ? result.stdout.trim() : undefined;
}
function sourceRemote(directory, repository, prepare = false) {
  const result = spawnSync("git", ["remote", "get-url", "source"], {
    cwd: directory,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (!result.stderr.includes("No such remote 'source'"))
      throw Error(
        "QUALITY_UPSTREAM_COMMAND_FAILED: " + (result.stderr || result.signal || result.status),
      );
    if (!prepare) throw Error("QUALITY_UPSTREAM_SOURCE_REMOTE_REQUIRED: " + directory);
    run("git", ["remote", "add", "source", repository], directory);
  } else if (result.stdout.trim() !== repository) {
    throw Error("QUALITY_UPSTREAM_SOURCE_REMOTE_MISMATCH: " + directory);
  }
}
async function sidebarSource(directory) {
  if (run("git", ["rev-parse", "HEAD"], directory, true) !== fixed.sidebar.head)
    throw Error("QUALITY_UPSTREAM_HEAD");
  if (run("git", ["status", "--porcelain", "--untracked-files=normal"], directory, true))
    throw Error("QUALITY_UPSTREAM_DIRTY");
  if (hash(await readFile(join(directory, "pnpm-lock.yaml"))) !== fixed.sidebar.lockSha256)
    throw Error("QUALITY_UPSTREAM_LOCK");
  if ((await json(join(directory, "package.json"))).packageManager !== fixed.sidebar.packageManager)
    throw Error("QUALITY_UPSTREAM_TOOLCHAIN");
}
export async function verifyQualityUpstreams(root) {
  if (!root) throw Error("QUALITY_UPSTREAM_REQUIRED");
  root = resolve(root);
  const genui = join(root, "upstream-assets/genui-0.11.3"),
    sidebar = join(root, "upstream-reference/dsh-better-sidebar");
  if (!(await exists(genui)) || !(await exists(sidebar)))
    throw Error("QUALITY_UPSTREAM_MATERIAL_REQUIRED");
  const files = await resourceDigests(genui);
  if (
    JSON.stringify(Object.keys(files).sort()) !==
      JSON.stringify(Object.keys(fixed.genui.files).sort()) ||
    Object.entries(files).some(([file, sha]) => fixed.genui.files[file] !== sha)
  )
    throw Error("QUALITY_UPSTREAM_HASH");
  await sidebarSource(sidebar);
  const genuiSource = join(root, "upstream-reference/dsh-genui");
  if (
    !(await exists(genuiSource)) ||
    run("git", ["rev-parse", "HEAD"], genuiSource, true) !== fixed.genui.head ||
    run("git", ["status", "--porcelain"], genuiSource, true)
  )
    throw Error("QUALITY_UPSTREAM_GENUI_SOURCE_REQUIRED");
  sourceRemote(genuiSource, fixed.genui.repository);
  sourceRemote(sidebar, fixed.sidebar.repository);
  const manifest = await json(join(sidebar, "package.json"));
  const required = new Set([
    manifest.main,
    manifest.types,
    "lib/client.js",
    "lib/invariant.js",
    "lib/client-registry.js",
    "lib/client-editor.js",
    "lib/client-locale.js",
    "lib/client-mermaid.js",
    "lib/types/client/service.d.ts",
  ]);
  const sidebarFiles = {};
  for (const file of required) {
    if (!file || !(await exists(join(sidebar, file))))
      throw Error("QUALITY_UPSTREAM_MATERIAL_REQUIRED: " + file);
    sidebarFiles[file] = hash(await readFile(join(sidebar, file)));
  }
  return {
    status: "prepared",
    root: await realpath(root),
    genui: {
      source: fixed.genui.url,
      repository: fixed.genui.repository,
      head: fixed.genui.head,
      archiveSha256: fixed.genui.sha256,
      files,
    },
    sidebar: {
      source: fixed.sidebar.repository,
      head: fixed.sidebar.head,
      lockSha256: fixed.sidebar.lockSha256,
      files: sidebarFiles,
    },
    runtime: "not-observed",
  };
}
export async function prepareQualityUpstreams(root) {
  if (!root) throw Error("QUALITY_UPSTREAM_REQUIRED");
  root = resolve(root);
  if (Number(process.versions.node.split(".")[0]) !== 24) throw Error("QUALITY_UPSTREAM_TOOLCHAIN");
  if ((await exists(root)) && (await realpath(root)) !== root)
    throw Error("QUALITY_UPSTREAM_PRIVATE_ROOT_REQUIRED");
  await mkdir(root, { recursive: true });
  const genui = join(root, "upstream-assets/genui-0.11.3"),
    sidebar = join(root, "upstream-reference/dsh-better-sidebar");
  if (!(await exists(genui))) {
    const response = await fetch(fixed.genui.url);
    if (!response.ok) throw Error("QUALITY_UPSTREAM_DOWNLOAD: " + response.status);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (hash(bytes) !== fixed.genui.sha256) throw Error("QUALITY_UPSTREAM_ARCHIVE_HASH");
    const archive = join(root, "genui-0.11.3.tgz"),
      staging = join(root, "genui-unpack");
    await writeFile(archive, bytes);
    await mkdir(staging);
    const paths = run("tar", ["-tzf", archive], root, true).split("\n");
    if (paths.some((path) => !path.startsWith("package/") || path.split("/").includes("..")))
      throw Error("QUALITY_UPSTREAM_ARCHIVE_PATH");
    run("tar", ["-xzf", archive, "-C", staging], root);
    await mkdir(dirname(genui), { recursive: true });
    await rename(join(staging, "package"), genui);
  }
  const genuiSource = join(root, "upstream-reference/dsh-genui");
  if (!(await exists(genuiSource))) {
    await mkdir(dirname(genuiSource), { recursive: true });
    run(
      "git",
      [
        "clone",
        "--no-checkout",
        "--no-hardlinks",
        "--origin",
        "source",
        fixed.genui.repository,
        genuiSource,
      ],
      root,
    );
    run("git", ["checkout", "--detach", fixed.genui.head], genuiSource);
  }
  if (!(await exists(sidebar))) {
    await mkdir(dirname(sidebar), { recursive: true });
    run(
      "git",
      [
        "clone",
        "--no-checkout",
        "--no-hardlinks",
        "--origin",
        "source",
        fixed.sidebar.repository,
        sidebar,
      ],
      root,
    );
    run("git", ["checkout", "--detach", fixed.sidebar.head], sidebar);
    run("git", ["config", "--local", "dsh.qualityUpstream", "independent-fixed-sidebar"], sidebar);
  }
  if (
    (await realpath(sidebar)) !== sidebar ||
    run("git", ["config", "--local", "--get", "dsh.qualityUpstream"], sidebar, true) !==
      "independent-fixed-sidebar"
  )
    throw Error("QUALITY_UPSTREAM_PRIVATE_ROOT_REQUIRED");
  await sidebarSource(sidebar);
  if (
    (await realpath(genuiSource)) !== genuiSource ||
    run("git", ["rev-parse", "HEAD"], genuiSource, true) !== fixed.genui.head ||
    run("git", ["status", "--porcelain"], genuiSource, true)
  )
    throw Error("QUALITY_UPSTREAM_GENUI_SOURCE_REQUIRED");
  sourceRemote(genuiSource, fixed.genui.repository, true);
  sourceRemote(sidebar, fixed.sidebar.repository, true);
  if (run("corepack", ["pnpm", "--version"], sidebar, true) !== "11.8.0")
    throw Error("QUALITY_UPSTREAM_TOOLCHAIN");
  run(
    "corepack",
    ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts", "--prefer-offline"],
    sidebar,
  );
  run("corepack", ["pnpm", "build"], sidebar);
  return verifyQualityUpstreams(root);
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { values } = parseArgs({
      options: {
        root: { type: "string" },
        prepare: { type: "boolean" },
        receipt: { type: "string" },
      },
    });
    const result = await (values.prepare ? prepareQualityUpstreams : verifyQualityUpstreams)(
      values.root,
    );
    if (values.receipt)
      await writeFile(resolve(values.receipt), JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
