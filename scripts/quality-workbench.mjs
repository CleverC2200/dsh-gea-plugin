/** Verify the existing clean-source/frozen-assets contract for the owned Workbench build. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, realpath, readlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { resourceDigests } from "./source-profile.mjs";
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
const derived = (file) => file.startsWith("lib/") || generatedHtml.has(file);
export async function readPreparedWorkbench({ source, prepared, head }) {
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
    ["-C", prepared, "status", "--porcelain", "--untracked-files=all"],
    { encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } },
  ).trimEnd();
  if (
    status
      .split("\n")
      .filter(Boolean)
      .some((line) => !line.startsWith(" M ") || !derived(line.slice(3)))
  )
    throw Error("QUALITY_WORKBENCH_PREPARED_SOURCE_CHANGED");
  const sourceFiles = git(source, "ls-tree", "-r", "-z", head)
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const at = entry.indexOf("\t");
      const [mode, , expected] = entry.slice(0, at).split(" ");
      return { file: entry.slice(at + 1), mode, expected };
    })
    .filter((entry) => !derived(entry.file));
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
  const files = await resourceDigests(prepared, "", true);
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
export async function verifyPreparedWorkbench({ source, prepared, head, receipt }) {
  if (!receipt) throw Error("QUALITY_WORKBENCH_RECEIPT_REQUIRED");
  const record = JSON.parse(await readFile(receipt, "utf8"));
  const current = await readPreparedWorkbench({ source, prepared, head });
  if (JSON.stringify(record) !== JSON.stringify(current))
    throw Error("QUALITY_WORKBENCH_ASSET_MISMATCH");
  return current;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { values } = parseArgs({
      options: {
        source: { type: "string" },
        prepared: { type: "string" },
        head: { type: "string" },
        receipt: { type: "string" },
      },
    });
    const result = await verifyPreparedWorkbench(values);
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
