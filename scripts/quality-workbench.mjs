/** Verify the existing clean-source/frozen-assets contract for the owned Workbench build. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, readdir, realpath, readlink, lstat, symlink, mkdir, cp } from "node:fs/promises";
import { resolve, join, dirname, relative } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { fileDigest } from "./source-combination-integrity.mjs";

async function preparedResourceDigests(directory, prefix = "") {
  const files = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (["node_modules", ".git"].includes(entry.name)) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const file = join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(files, await preparedResourceDigests(file, relative));
    else if (entry.isSymbolicLink()) files[relative] = "link:" + (await realpath(file));
    else if (entry.isFile()) files[relative] = await fileDigest(file);
  }
  return files;
}
const git = (root, ...args) =>
  execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  }).trim();
const generatedHtml = new Set([
  "static/category/index.html",
  "static/mps/index.html",
  "static/regional/index.html",
]);
export const isPreparedWorkbenchOutput = (file) =>
  file.startsWith("lib/") || generatedHtml.has(file);

/** Bind the fixed Workbench reader to the already admitted GEA authority without copying it. */
export async function prepareWorkbenchGeaAuthority({ workbench, gea }) {
  const target = await realpath(gea),
    sibling = resolve(dirname(workbench), "dsh-gea-plugin");
  let existing;
  try {
    existing = await lstat(sibling);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (existing) {
    let actual;
    try {
      actual = await realpath(sibling);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (actual !== target) throw Error("QUALITY_WORKBENCH_GEA_AUTHORITY_MISMATCH: " + sibling);
    return;
  }
  await symlink(target, sibling, "dir");
}
export async function readPreparedWorkbench({ source, prepared, head, manage }) {
  if (!source || !prepared || !head) throw Error("QUALITY_WORKBENCH_INPUT_REQUIRED");
  source = await realpath(source);
  prepared = await realpath(prepared);
  if (
    source === prepared ||
    git(source, "rev-parse", "HEAD") !== head ||
    git(prepared, "rev-parse", "HEAD") !== head
  )
    throw Error("QUALITY_WORKBENCH_SOURCE_MISMATCH");
  if (git(source, "status", "--porcelain", "--untracked-files=all"))
    throw Error("QUALITY_WORKBENCH_SOURCE_DIRTY");
  const status = execFileSync(
    "git",
    ["-C", prepared, "status", "--porcelain", "--untracked-files=all", "-z"],
    { encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } },
  );
  for (const line of status.split("\0").filter(Boolean)) {
    const file = line.slice(3);
    if (line.startsWith(" M ") && isPreparedWorkbenchOutput(file)) continue;
    if (
      line.startsWith(" D ") &&
      /^lib\/types\/.+\.d\.ts$/.test(file) &&
      /^100644 blob [a-f0-9]{40}\t/.test(git(source, "ls-tree", head, "--", file))
    )
      continue;
    if (line.startsWith("?? ") && file.startsWith("lib/types/") && file.endsWith(".d.ts")) {
      // Declaration emission adds regular files; lstat never follows external targets.
      if ((await lstat(join(prepared, file))).isFile()) continue;
    }
    if (
      line.startsWith("?? ") &&
      /^lib\/(?:business\/inventory-(?:aqkc|fc|qll|apsplan|dealer|orderfulfillment)|static\/mps)\/sql\.config\.json$/.test(
        file,
      )
    ) {
      const resource = file.slice(4);
      const entry = git(source, "ls-tree", head, "--", resource);
      const original = join(source, resource),
        output = join(prepared, file);
      if (
        /^100644 blob [a-f0-9]{40}\t/.test(entry) &&
        (await lstat(output)).isFile() &&
        (await realpath(output)) === output &&
        (await lstat(original)).isFile() &&
        (await realpath(original)) === original
      ) {
        const bytes = await readFile(original);
        const blob = createHash("sha1")
          .update("blob " + bytes.length + "\0")
          .update(bytes)
          .digest("hex");
        if (entry.split("\t")[0].endsWith(" " + blob) && bytes.equals(await readFile(output)))
          continue;
      }
    }
    if (
      line.startsWith("?? ") &&
      /^lib\/business\/(?:inventory-(?:aqkc|apsplan|customer|orderfulfillment|orderworkbench)\/skills\/|inventory-orderfulfillment\/(?:agent-prompt\.md|SOURCE\.json|README\.md)$)/.test(
        file,
      ) &&
      manage
    ) {
      const owner = await realpath(manage.path);
      if (!/^[a-f0-9]{40}$/.test(manage.head) || git(owner, "rev-parse", "HEAD") !== manage.head)
        throw Error("QUALITY_WORKBENCH_MANAGE_SOURCE_MISMATCH");
      const resource = file.replace(/^lib\/business\//, "business-resources/");
      const entry = git(owner, "ls-tree", manage.head, "--", resource);
      const original = join(owner, resource),
        output = join(prepared, file);
      if (
        /^100644 blob [a-f0-9]{40}\t/.test(entry) &&
        (await lstat(output)).isFile() &&
        (await realpath(output)) === output &&
        (await lstat(original)).isFile() &&
        (await realpath(original)) === original
      ) {
        const bytes = await readFile(original);
        const blob = createHash("sha1")
          .update("blob " + bytes.length + "\0")
          .update(bytes)
          .digest("hex");
        if (entry.split("\t")[0].endsWith(" " + blob) && bytes.equals(await readFile(output)))
          continue;
      }
    }
    throw Error("QUALITY_WORKBENCH_PREPARED_SOURCE_CHANGED: " + line);
  }
  const sourceFiles = git(source, "ls-tree", "-r", "-z", head)
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const at = entry.indexOf("\t");
      const [mode, , expected] = entry.slice(0, at).split(" ");
      return { file: entry.slice(at + 1), mode, expected };
    })
    .filter((entry) => !isPreparedWorkbenchOutput(entry.file));
  for (const { file, mode, expected } of sourceFiles) {
    const bytes =
      mode === "120000"
        ? Buffer.from(await readlink(join(prepared, file)))
        : await readFile(join(prepared, file));
    const actual = createHash("sha1")
      .update("blob " + bytes.length + "\0")
      .update(bytes)
      .digest("hex");
    if (actual !== expected) throw Error("QUALITY_WORKBENCH_SOURCE_BLOB_MISMATCH: " + file);
  }
  if (git(source, "remote", "get-url", "source") !== git(prepared, "remote", "get-url", "source"))
    throw Error("QUALITY_WORKBENCH_ORIGIN_MISMATCH");
  for (const file of [
    "lib/host.js",
    "lib/client.js",
    "lib/types/host.d.ts",
    "lib/types/client.d.ts",
  ])
    await readFile(join(prepared, file));
  const files = await preparedResourceDigests(prepared);
  return {
    source,
    prepared,
    head,
    status: "prepared",
    sourceFiles: sourceFiles.length,
    trackedOutputDiff: status,
    files,
  };
}
export async function verifyPreparedWorkbench({ source, prepared, head, manage, receipt }) {
  if (!receipt) throw Error("QUALITY_WORKBENCH_RECEIPT_REQUIRED");
  const record = JSON.parse(await readFile(receipt, "utf8"));
  const current = await readPreparedWorkbench({ source, prepared, head, manage });
  if (JSON.stringify(record) !== JSON.stringify(current))
    throw Error("QUALITY_WORKBENCH_ASSET_MISMATCH");
  return current;
}
/** Keep publishable assets separate from the prepared worktree's Git metadata and dependency store. */
export async function prepareWorkbenchAssets({ source, prepared, head, manage, receipt, assets }) {
  const record = await verifyPreparedWorkbench({
    source,
    prepared,
    head,
    manage,
    receipt,
  });
  await mkdir(assets);
  await cp(record.prepared, assets, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (file) =>
      !relative(record.prepared, file)
        .split(/[\\/]/)
        .some((part) => [".git", "node_modules"].includes(part)),
  });
  const files = await preparedResourceDigests(assets);
  if (
    JSON.stringify(Object.entries(files).sort()) !==
    JSON.stringify(Object.entries(record.files).sort())
  )
    throw Error("QUALITY_WORKBENCH_ASSET_MISMATCH");
  return { assets: await realpath(assets), files };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { values } = parseArgs({
      options: {
        source: { type: "string" },
        prepared: { type: "string" },
        head: { type: "string" },
        receipt: { type: "string" },
        "manage-source": { type: "string" },
        "manage-head": { type: "string" },
      },
    });
    if (Boolean(values["manage-source"]) !== Boolean(values["manage-head"]))
      throw Error("QUALITY_WORKBENCH_MANAGE_INPUT_REQUIRED");
    const result = await verifyPreparedWorkbench({
      ...values,
      manage: values["manage-source"]
        ? { path: values["manage-source"], head: values["manage-head"] }
        : undefined,
    });
    console.log(
      JSON.stringify({
        status: result.status,
        source: result.source,
        prepared: result.prepared,
        head: result.head,
        assets: Object.keys(result.files).length,
      }),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
